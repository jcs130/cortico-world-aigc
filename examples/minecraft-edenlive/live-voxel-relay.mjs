/** Explicit, read-only voxel input and bounded output relay for an EdenLive experiment. */
import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {matchReference,readReferencePair} from 'agent-mc-world/capture';

const cfg = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!cfg.publishKey || cfg.publishKey.length < 24) throw Error('An explicit private publisher key is required');
if(cfg.sourceMode!=='voxel-scene-demo'&&(!cfg.referencePolicy||!cfg.anchorFile||!cfg.referenceReadyFile))throw Error('Live sessions require a receipt-bound anchor and explicit camera admission limits');
const req = createRequire(cfg.dependenciesPackage), core = createRequire(cfg.corePackage);
const { default: puppeteer } = await import(pathToFileURL(req.resolve('puppeteer-core')));
const { WebSocketServer } = req('ws');
const { ViewerGameplayObserver } = await import(pathToFileURL(core.resolve('agent-mc-world/learning')));
const ownRequire = createRequire(new URL('../../package.json',import.meta.url));
const threeRoot = dirname(cfg.threeModule ?? ownRequire.resolve('three'));
const observer = new ViewerGameplayObserver(cfg.viewer, 'edenlive-read-only', null);
let scene = JSON.parse(await readFile(cfg.firstSceneFile, 'utf8'));
let initialReferenceAt=Date.parse(scene.sampledAt);
if(!Number.isFinite(initialReferenceAt))throw Error('Initial reference needs a real scene sampledAt timestamp');
if (scene.source.uuid !== cfg.viewer.expectedUuid || scene.source.username !== cfg.viewer.expectedUsername)
  throw Error('Initial scene identity does not match pinned live viewer');
const assetPack = JSON.parse(await readFile(join(cfg.assetPack, 'pack.json'), 'utf8'));
async function asset(name) {
  const bytes = await readFile(join(cfg.assetPack, name));
  if (createHash('sha256').update(bytes).digest('hex') !== assetPack.files[name]?.sha256) throw Error('Asset hash mismatch: '+name);
  return bytes;
}
const catalog = await asset('public/blocksStates/1.21.1.json'), atlas = await asset('public/textures/1.21.1.png');
let initial = await readFile(cfg.firstProxyFile);
const demo=cfg.sourceMode==='voxel-scene-demo';
const runtime = { phase:'starting', createdAt:new Date().toISOString(), sourceMode:demo?'voxel-scene-demo':'live-voxel-sdk', sourceFresh:false,
  gameplayLive:!demo,initialReferenceSampledAt:scene.sampledAt,sceneSampledAt:scene.sampledAt,
  sourceSequence:0, generatedSequence:0, droppedOutputFrames:0, chunks:0, worker:null, error:null };
const inputRing = [], outputQueue = [], sinks = {source:new Set(),generated:new Set()}, times={source:[],generated:[]},watchers=new Set();
const acceptedChunks=new Map();
let browser, page, closed=false, workerFinal=false, latestSource=null, latestOutput=null, captureTimer, presentationTimer;
let nextFrame=0, lastCellRevision=-1, meshUpdatedAt=0, inputFirst=true;
const recorded = resolve(cfg.recordDir); await mkdir(recorded,{recursive:true});
await writeFile(join(recorded,'runtime.json'),JSON.stringify({createdAt:runtime.createdAt,input:cfg.firstSceneFile,purpose:'real-time experiment',platformStreamingStarted:false}));
const fps = k => times[k].length>1&&Date.now()-times[k].at(-1)<3000 ? +(1000*(times[k].length-1)/(times[k].at(-1)-times[k][0])).toFixed(2) : 0;
const status = () => ({...runtime,sourceFps:fps('source'),deliveredFps:fps('generated'),outputQueue:outputQueue.length,
  sourceAgeMs:latestSource?Date.now()-latestSource.at:null,generatedAgeMs:latestOutput?Date.now()-latestOutput.at:null,
  sourceToPresentationMs:latestOutput?.lagMs??null,outputInputMode:latestOutput?.inputSourceMode??null,sourceCamera:latestSource?.camera??null,observer:observer.status(),imageSize:[1280,704],audio:false});
function publish(kind, bytes, meta={}) {
  const now=Date.now(), frame={bytes,at:now,...meta};
  if(kind==='source'){frame.sequence=++runtime.sourceSequence;latestSource=frame;inputRing.push(frame);if(inputRing.length>72)inputRing.shift();}
  else {frame.sequence=++runtime.generatedSequence;latestOutput=frame;}
  times[kind].push(now);if(times[kind].length>120)times[kind].shift();
  const header=Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`);
  for(const res of sinks[kind])if(!res.destroyed&&res.writableLength<512*1024){res.write(header);res.write(bytes);res.write('\r\n');}
  if(kind==='generated')for(const ws of watchers)if(ws.readyState===1&&ws.bufferedAmount<512*1024){ws.send(JSON.stringify({sequence:frame.sequence,chunk:frame.chunk,inputAt:now-frame.lagMs,relayAt:now}));ws.send(bytes);}
  if(kind==='generated' && frame.sequence<=(cfg.recordFrames??1200)) {
    const name=`f${String(frame.sequence).padStart(6,'0')}.jpg`;
    void writeFile(join(recorded,name),bytes);
    void appendFile(join(recorded,'presentation.jsonl'),JSON.stringify({name,at:now,chunk:frame.chunk,lagMs:frame.lagMs})+'\n');
  }
}
function json(res,value,code=200){res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(value));}
async function body(request){let total=0;const a=[];for await(const b of request){total+=b.length;if(total>12*1024*1024)throw Error('Payload too large');a.push(b);}return JSON.parse(Buffer.concat(a));}
const preview=`<!doctype html><meta charset="utf-8"><title>EdenLive · 实时体素渲染</title><style>body{margin:0;background:#11171b;color:#e3ede8;font:16px system-ui}header{padding:12px 20px}main{display:flex;gap:8px;padding:8px}figure{margin:0;flex:1}img{width:100%;display:block}figcaption{padding:8px;color:#a8bbb4}pre{padding:12px;white-space:pre-wrap;font:14px monospace}.warning{color:#ffc785}body.obs header,body.obs #raw,body.obs pre,body.obs figcaption{display:none}body.obs main{padding:0}#stale{position:fixed;bottom:12px;left:16px;padding:8px 12px;background:#17251ee0}</style><header>EdenLive · 实时体素增强实验 <span class="warning">（几何、人物和动作可能漂移；静音）</span></header><main><figure id="raw"><img src="/source.mjpeg"><figcaption>原始体素输入 · 同一可米连接的方块与位姿</figcaption></figure><figure><img id="ai" src="/generated.mjpeg"><figcaption>AI 生成输出 · LightX2V INT8 / LightTAE</figcaption></figure></main><pre id="stats"></pre><div id="stale">等待生成画面</div><script>if(location.pathname==='/obs')document.body.classList.add('obs');setInterval(async()=>{try{const s=await(await fetch('/health')).json();stats.textContent=JSON.stringify({phase:s.phase,sourceFps:s.sourceFps,deliveredFps:s.deliveredFps,sourceToPresentationMs:s.sourceToPresentationMs,queue:s.outputQueue,dropped:s.droppedOutputFrames,sourceFresh:s.sourceFresh,worker:s.worker},null,2);const ok=s.sourceFresh&&s.outputInputMode!=='anchor-reference'&&s.generatedAgeMs!==null&&s.generatedAgeMs<2500;stale.textContent=s.outputInputMode==='anchor-reference'?'参考锚点热启动 · 尚非当前游玩画面':ok?'AI 生成 · 实时体素输入':s.generatedAgeMs===null?'等待 AI 推理就绪':'AI 输出已停止或信号过期';stale.style.color=ok?'#c5efcf':'#ffd39b';ai.style.opacity=ok?1:.45;}catch{stale.textContent='信号中断';ai.style.opacity=.35;}},500)</script>`;
const files=new Map([['/three.module.js',join(threeRoot,'three.module.js')],['/three.core.js',join(threeRoot,'three.core.js')]]);
const browserScript=`<script>window.edenDisplay={frames:0,sequence:0,lagMs:[],transportMs:[],times:[],decodeErrors:0};let meta;const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/watch');ws.binaryType='arraybuffer';ws.onmessage=async e=>{if(typeof e.data==='string'){meta=JSON.parse(e.data);return}const m=meta,s=window.edenDisplay;if(!m)return;try{const b=await createImageBitmap(new Blob([e.data],{type:'image/jpeg'}));if(m.sequence<=s.sequence){b.close();return}if(ai.width!==b.width||ai.height!==b.height){ai.width=b.width;ai.height=b.height}ai.getContext('2d',{alpha:false}).drawImage(b,0,0);b.close();s.frames++;s.sequence=m.sequence;s.times.push(Date.now());s.lagMs.push(Date.now()-m.inputAt);s.transportMs.push(Date.now()-m.relayAt);for(const a of [s.times,s.lagMs,s.transportMs])if(a.length>120)a.shift();}catch{s.decodeErrors++;}};</script>`;
const server=createServer(async(request,response)=>{try{
  const u=new URL(request.url,'http://local'),route=u.pathname;
  if(request.method==='POST') {
    if(request.headers.authorization!=='Bearer '+cfg.publishKey)return json(response,{error:'publisher authentication required'},401);
    const b=await body(request);
    if(route==='/shutdown'){json(response,{ok:true,stopping:true});setTimeout(()=>void stop(),0);return;}
    if(route==='/worker') {if(workerFinal&& !['stopped','cancelled','error'].includes(b.phase))return json(response,{error:'session terminal'},409);runtime.worker=b;runtime.phase=b.phase;if(['completed','stopped','cancelled','error'].includes(b.phase))workerFinal=true;return json(response,{ok:true});}
    if(route==='/generated') {
      if(workerFinal||closed)return json(response,{error:'session terminal'},409);
      if(!Array.isArray(b.frames)||b.frames.length<1||b.frames.length>16)throw Error('Invalid decoded chunk');
      const key=String(b.profile??runtime.worker?.profile)+':'+String(b.chunk),digest=createHash('sha256').update(JSON.stringify(b)).digest('hex');
      if(acceptedChunks.has(key))return acceptedChunks.get(key)===digest?json(response,{ok:true,reused:true,queued:outputQueue.length}):json(response,{error:'chunk ID conflict'},409);
      const decoded=b.frames.map(encoded=>{const bytes=Buffer.from(encoded,'base64');if(bytes[0]!==255||bytes[1]!==216)throw Error('JPEG required');return bytes;});
      runtime.chunks++;runtime.phase='generating';runtime.worker={...runtime.worker,lastChunk:b.chunk,inferenceMs:b.inferenceMs,inputAt:b.inputAt,outputFrames:b.frames.length};
      for(const bytes of decoded)outputQueue.push({bytes,chunk:b.chunk,inputAt:b.inputAt,inputSourceMode:b.inputSourceMode??'unknown'});
      acceptedChunks.set(key,digest);if(acceptedChunks.size>4096)acceptedChunks.delete(acceptedChunks.keys().next().value);
      while(outputQueue.length>24){outputQueue.shift();runtime.droppedOutputFrames++;}
      return json(response,{ok:true,queued:outputQueue.length});
    }
    return json(response,{error:'unknown mutation'},404);
  }
  if(request.method!=='GET')return response.writeHead(405).end();
  if(route==='/health')return json(response,status());
  if(route==='/'||route==='/obs'){
    let html=preview.replace('<img id="ai" src="/generated.mjpeg">','<canvas id="ai" width="1280" height="704" style="width:100%;display:block"></canvas>')+browserScript;
    if(demo)html=html.replace('EdenLive · 实时体素增强实验','EdenLive · 冻结场景的实时渲染实验').replace('原始体素输入 · 同一可米连接的方块与位姿','冻结的可米体素场景 · 测试相机运动，不代表当前游玩').replace("'AI 生成 · 实时体素输入'","'AI 实时生成 · 冻结场景动态机位测试'");
    return response.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}).end(html);
  }
  if(route==='/proxy-chunk') {
    const after=Number(u.searchParams.get('after')??0),deadline=Date.now()+5000;
    if(inputFirst||after<0){
      let referenceCamera=scene.camera;
      if(cfg.referencePolicy){
        const reference=await readReferencePair({scene:cfg.firstSceneFile,proxy:cfg.firstProxyFile,anchor:cfg.anchorFile,receipt:cfg.referenceReadyFile});
        if(reference.scene.source.uuid!==cfg.viewer.expectedUuid||reference.scene.source.username!==cfg.viewer.expectedUsername||reference.scene.source.dimension!==scene.source.dimension)throw Error('Reference source identity mismatch');
        const current=observer.readScene({radius:0,below:0,above:0,eyeHeight:cfg.region.eyeHeight,fovDegrees:cfg.region.fovDegrees}).camera;
        runtime.referenceMatch=matchReference(reference.scene.camera,current,cfg.referencePolicy,reference.scene.sampledAt);
        if(!runtime.referenceMatch.accepted)return json(response,{error:'REFERENCE_CAMERA_MISMATCH',match:runtime.referenceMatch},409);
        initial=reference.proxy;initialReferenceAt=Date.parse(reference.scene.sampledAt);referenceCamera=reference.scene.camera;
        runtime.initialReferenceSampledAt=reference.scene.sampledAt;
      }
      inputFirst=false;return json(response,{initial:true,sourceMode:'anchor-reference',sourceFresh:false,inputAt:initialReferenceAt,sequence:0,cameraFrames:[referenceCamera,referenceCamera,referenceCamera],frames:[initial.toString('base64'),initial.toString('base64'),initial.toString('base64')]});
    }
    while(!closed&&Date.now()<deadline) {
      const last=inputRing.at(-1);
      if(runtime.sourceFresh&&last&&last.sequence>after&&inputRing.length>=9){const n=inputRing.length,selected=[inputRing[n-9],inputRing[n-5],last];return json(response,{initial:false,sourceMode:runtime.sourceMode,sourceFresh:true,inputAt:inputRing[n-9].at,sequence:last.sequence,cameraFrames:selected.map(f=>f.camera),frames:selected.map(f=>f.bytes.toString('base64'))});}
      await new Promise(r=>setTimeout(r,25));
    }
    return json(response,{error:'no fresh pinned voxel input'},503);
  }
  for(const kind of ['source','generated']) {
    const frame=kind==='source'?latestSource:latestOutput;
    if(route===`/${kind}.jpg`){if(!frame)return response.writeHead(503).end();return response.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'}).end(frame.bytes);}
    if(route===`/${kind}.mjpeg`){response.writeHead(200,{'Content-Type':'multipart/x-mixed-replace; boundary=frame','Cache-Control':'no-store'});sinks[kind].add(response);request.on('close',()=>sinks[kind].delete(response));return;}
  }
  if(route==='/scene.json')return json(response,scene);
  if(route==='/catalog.json')return response.writeHead(200,{'Content-Type':'application/json'}).end(catalog);
  if(route==='/atlas.png')return response.writeHead(200,{'Content-Type':'image/png'}).end(atlas);
  if(route==='/render.json')return json(response,cfg.render);
  if(route==='/asset-evidence.json')return json(response,{source:assetPack.source,live:true});
  let file=files.get(route);
  if(route.startsWith('/viewer/src/')){const p=resolve(cfg.rendererSource,'src',route.slice('/viewer/src/'.length)),rel=relative(join(cfg.rendererSource,'src'),p);if(!rel.startsWith('..')&&!isAbsolute(rel))file=p;}
  if(!file)return response.writeHead(404).end();
  const bytes=await readFile(file);
  response.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':'text/javascript','Cache-Control':'no-store'}).end(bytes);
}catch(e){json(response,{error:String(e.message).slice(0,200)},500);}});
const wss=new WebSocketServer({server,maxPayload:1024});
wss.on('connection',(ws,request)=>{if(request.url!=='/watch')return ws.close(1008);watchers.add(ws);ws.on('message',()=>ws.close(1008,'Read-only viewer'));ws.on('close',()=>watchers.delete(ws));ws.on('error',()=>{});});
await new Promise((done,fail)=>{server.once('error',fail);server.listen(cfg.port,cfg.host??'127.0.0.1',done);});
const origin=`http://127.0.0.1:${server.address().port}`;
if(!demo)observer.start();
browser=await puppeteer.launch({executablePath:cfg.executablePath,headless:true,args:['--mute-audio','--disable-background-networking','--disable-component-update','--no-first-run','--disable-background-timer-throttling']});
page=await browser.newPage();await page.setViewport({width:1280,height:704});
page.on('pageerror',e=>{runtime.error=String(e.message);});
await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin+'/')?r.continue():r.abort());
async function loadPage(){await page.goto(origin+'/viewer/src/modern-viewer/voxel-proxy.html');await page.waitForFunction('window.proxyReady===true',{timeout:30000});const renderer=await page.evaluate(()=>window.proxyDetails().renderer);if(renderer?.threeRevision!==(cfg.expectedThreeRevision??'186'))throw Error('Renderer Three.js revision mismatch: '+renderer?.threeRevision);if(!renderer.capabilities?.setProxyPose||!renderer.capabilities.rgbFrameFormats?.includes('image/jpeg'))throw Error('Renderer public live pose/JPEG capability unavailable');meshUpdatedAt=Date.now();}
await loadPage();
console.log(JSON.stringify({event:'live-voxel-ready',url:origin,obs:origin+'/obs',readonly:true}));
async function capture(){
  if(closed)return;
  const start=Date.now(),s=observer.status();runtime.sourceFresh=demo||(s.connected&&s.actorMatched&&s.sourceAgeMs!==null&&s.sourceAgeMs<1500);
  try {
    if(runtime.sourceFresh){
      const pose=demo?scene.camera:observer.readScene({radius:0,below:0,above:0,eyeHeight:1.62,fovDegrees:75}).camera;
      const moved=Math.hypot(...pose.feet.map((v,i)=>v-scene.camera.feet[i]))>6;
      if(!demo&&(moved||s.cachedBlockUpdates!==lastCellRevision)&&Date.now()-meshUpdatedAt>5000){scene=observer.readScene(cfg.region);runtime.sceneSampledAt=scene.sampledAt;lastCellRevision=s.cachedBlockUpdates;await loadPage();}
      const offset=demo ? 0.18*Math.sin((start-Date.parse(runtime.createdAt))/18000) : 0;
      const encoded=await page.evaluate(([p,o])=>{window.setProxyPose(p);return window.renderProxy(o,false,{mime:'image/jpeg',quality:.88});},[pose,offset]);
      publish('source',Buffer.from(encoded.split(',')[1],'base64'),{sourceAgeMs:s.sourceAgeMs,camera:pose});runtime.error=null;
    }
  }catch(e){runtime.error=String(e.message).slice(0,200);runtime.sourceFresh=false;}
  captureTimer=setTimeout(capture,Math.max(1,1000/(cfg.sourceFps??24)-(Date.now()-start)));
}
void capture();
presentationTimer=setInterval(()=>{if(!outputQueue.length)return;const f=outputQueue.shift();publish('generated',f.bytes,{chunk:f.chunk,lagMs:Date.now()-f.inputAt,inputSourceMode:f.inputSourceMode});},1000/24);
async function stop(){if(closed)return;closed=true;workerFinal=true;runtime.phase='stopped';clearTimeout(captureTimer);clearInterval(presentationTimer);outputQueue.length=0;await writeFile(join(recorded,'final-health.json'),JSON.stringify(status(),null,2));for(const set of Object.values(sinks))for(const s of set)s.end();for(const ws of watchers)ws.close();wss.close();if(!demo)await observer.stop();await browser?.close();server.closeAllConnections();server.close();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
