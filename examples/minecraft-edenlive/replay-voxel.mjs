/** Offline render from archived public scenes. This module never imports a game SDK. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {readRecording,sampleTimeline,interpolatePose,sha256} from 'agent-mc-world/capture';

const cfg=JSON.parse(await readFile(process.argv[2],'utf8'));
const recording=await readRecording(cfg.recordingDir),{manifest}=recording;
const fps=cfg.fps??24,frames=cfg.frames??(4*Math.floor(manifest.durationMs*fps/4000)+1);
if(fps!==24||!Number.isInteger(frames)||frames<5||frames>721||(frames-1)%4||(frames-1)*1000/fps>manifest.durationMs+1)throw Error('Finite 24 FPS, 4n+1 replay within the recorded timeline required');
const output=resolve(cfg.outputDir);await mkdir(output);await mkdir(join(output,'frames'));
const pitchOffset=cfg.cameraTransform?.pitchOffsetDegrees??0;
if(!Number.isFinite(pitchOffset)||Math.abs(pitchOffset)>60)throw Error('Virtual pitch offset must be within 60 degrees');
const orbit=cfg.virtualOrbitRadians??0,maxGap=cfg.poseInterpolationMaxGapMs??500;
if(!Number.isFinite(orbit)||Math.abs(orbit)>1||!Number.isFinite(maxGap)||maxGap<0||maxGap>2000)throw Error('Bounded virtual orbit and pose interpolation required');
const scenes=[];for(let i=0;i<manifest.frames.length;i++)scenes.push(await recording.scene(i));
let currentScene=scenes[0];const render={...manifest.renderSettings,...cfg.render};
if(render.showSelf&&!render.cameraOffset)throw Error('Self marker requires an explicit virtual camera');
const viewerRoot=resolve(cfg.rendererSource),require=createRequire(cfg.dependenciesPackage);
const {default:puppeteer}=await import(pathToFileURL(require.resolve('puppeteer-core')));
if(!cfg.threeModule)throw Error('An explicit Three.js module matching the renderer version is required');
const threeRoot=dirname(cfg.threeModule);
const atlas=await recording.bytes('assets/atlas.png'),catalog=await recording.bytes('assets/catalog.json'),evidence=await recording.bytes('assets/evidence.json');
const supplied=new Map([['/atlas.png',atlas],['/catalog.json',catalog],['/asset-evidence.json',evidence],['/render.json',Buffer.from(JSON.stringify(render))]]);
const modules=new Map([['/three.module.js',join(threeRoot,'three.module.js')],['/three.core.js',join(threeRoot,'three.core.js')]]),servedSources={},requests=[];
const server=createServer(async(req,res)=>{try{
 const route=new URL(req.url,'http://local').pathname;
 if(req.method!=='GET')return res.writeHead(405).end();
 if(route==='/scene.json')return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(currentScene));
 if(supplied.has(route))return res.writeHead(200,{'Content-Type':route.endsWith('.png')?'image/png':'application/json'}).end(supplied.get(route));
 let file=modules.get(route);
 if(route.startsWith('/viewer/src/')){const candidate=resolve(viewerRoot,'src',route.slice('/viewer/src/'.length)),rel=relative(join(viewerRoot,'src'),candidate);if(!rel.startsWith('..')&&!isAbsolute(rel))file=candidate;}
 if(!file)return res.writeHead(404).end();
 const bytes=await readFile(file);servedSources[route]={sha256:sha256(bytes),bytes:bytes.length};
 res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':'text/javascript'}).end(bytes);
}catch(e){res.writeHead(500).end(String(e.message));}});
await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const errors=[],frameMap=[],began=performance.now();
try{
 browser=await puppeteer.launch({executablePath:cfg.executablePath,headless:true,args:['--mute-audio','--disable-background-networking','--disable-component-update','--no-first-run','--disable-background-timer-throttling']});
 const page=await browser.newPage();await page.setViewport({width:1280,height:704});
 page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
 page.on('request',r=>{if(r.url().startsWith(origin+'/')){requests.push(r.url().slice(origin.length));r.continue();}else{errors.push('External renderer request blocked: '+r.url());r.abort();}});
 let loadedGeometry;
 for(let i=0;i<frames;i++){
  const tMs=i*1000/fps,{low,high,blend}=sampleTimeline(manifest.frames,tMs,maxGap),geometry=manifest.frames[low].geometrySha256;
  currentScene=scenes[low];
  if(geometry!==loadedGeometry){
   await page.goto(origin+'/viewer/src/modern-viewer/voxel-proxy.html');
   await page.waitForFunction('window.proxyReady===true',{timeout:60000}).catch(e=>{throw Error(errors.join('\n')||e.message);});
   if(!await page.evaluate(()=>typeof window.setProxyPose==='function'))throw Error('Renderer needs the public setProxyPose API; no runtime source patch is applied');
   const revision=await page.evaluate(()=>window.proxyDetails().renderer?.threeRevision);
   if(revision!==(cfg.expectedThreeRevision??'186'))throw Error('Renderer Three.js revision mismatch: '+revision);
   loadedGeometry=geometry;
  }
  const pose=interpolatePose(scenes[low].camera,scenes[high].camera,blend);
  pose.pitch=Math.max(-Math.PI/2,Math.min(Math.PI/2,pose.pitch+pitchOffset*Math.PI/180));
  await page.evaluate(p=>window.setProxyPose(p),pose);
  if(i===0){
   const mask=await page.evaluate(()=>window.renderProxy(0,true));await writeFile(join(output,'semantic.png'),Buffer.from(mask.split(',')[1],'base64'));
   const details={...await page.evaluate(()=>window.proxyDetails()),...await page.evaluate(()=>window.semanticPixels())};
   await writeFile(join(output,'semantics.json'),JSON.stringify(details,null,2));
   await writeFile(join(output,'scene.json'),JSON.stringify(currentScene));
  }
  const offset=orbit*i/(frames-1);
  const png=await page.evaluate(value=>window.renderProxy(value,false),offset);
  await writeFile(join(output,'frames',`f${String(i+1).padStart(5,'0')}.png`),Buffer.from(png.split(',')[1],'base64'));
  frameMap.push({frame:i,tMs,sourceLow:low,sourceHigh:high,interpolation:blend,virtualOrbitRadians:offset,geometrySha256:geometry,sampledAt:currentScene.sampledAt});
 }
 if(errors.length)throw Error(errors.join('\n'));
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-framerate',String(fps),'-i',join(output,'frames','f%05d.png'),'-c:v','libx264','-crf','16','-pix_fmt','yuv420p',join(output,'recording.mp4')],{windowsHide:true});
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',join(output,'recording.mp4'),'-frames:v','1','-update','1',join(output,'proxy-first.png')],{windowsHide:true});
 const semantics=JSON.parse(await readFile(join(output,'semantics.json'),'utf8'));
 semantics.primaryImageSha256=sha256(await readFile(join(output,'proxy-first.png')));semantics.semanticImageSha256=sha256(await readFile(join(output,'semantic.png')));
 await writeFile(join(output,'semantics.json'),JSON.stringify(semantics,null,2));
 const receipt={schema:'agent-mc-render-replay/v1',sourceKind:manifest.kind,source:manifest.source,recordingManifestSha256:sha256(await readFile(join(recording.root,'manifest.json'))),frames,fps,renderSeconds:(performance.now()-began)/1000,rendererEvidence:manifest.rendererEvidence,servedSources,renderSettings:render,cameraTransform:cfg.cameraTransform??null,virtualOrbitRadians:orbit,poseInterpolationMaxGapMs:maxGap,viewKind:cfg.cameraTransform||orbit?'offline-virtual-projection':'observed-eye-projection',frameMap,rendererRequestOrigins:['loopback-only'],gameSdkImported:false,gameConnectionOpened:false,errors,proxySha256:sha256(await readFile(join(output,'recording.mp4'))),firstFrameSha256:semantics.primaryImageSha256,limitations:manifest.limitations};
 await writeFile(join(output,'replay.json'),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({state:'replayed',frames,fps,seconds:frames/fps,renderSeconds:receipt.renderSeconds,gameConnectionOpened:false,errors,outputDir:output}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
