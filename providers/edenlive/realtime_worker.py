"""Bounded EdenLive AR session with fresh voxel input and incremental JPEG output.

The cache/denoising sequence follows ModelTC/LightX2V's Apache-2.0
lightx2v/models/runners/wan/edenlive_runner.py. Upstream code/weights stay external.
Only explicitly configured local relay endpoints are used; no game controls or LLM.
"""
import base64
import json
import math
import os
import signal
import sys
import time
import types
import urllib.request
import urllib.error
import ipaddress
import hashlib
from urllib.parse import urlsplit
from pathlib import Path

os.environ.setdefault('DTYPE', 'BF16')
os.environ.setdefault('SENSITIVE_LAYER_DTYPE', 'BF16')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('PROFILING_DEBUG_LEVEL', '0')
os.environ.setdefault('OMP_NUM_THREADS', '16')
os.environ.setdefault('PYTORCH_ALLOC_CONF', 'expandable_segments:True')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')

import cv2
import numpy as np
import torch
from lightx2v.models.runners.runner_factory import build_runner
from lightx2v.utils.set_config import build_startup_config
from lightx2v.models.input_encoders.edenlive.recording import prepare_cover
from lightx2v.common.kvcache.manager import build_self_attn_kv_cache
from lightx2v.utils.envs import GET_DTYPE
from lightx2v_platform.base.global_var import AI_DEVICE

cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
base=cfg['relayUrl'].rstrip('/')
url=urlsplit(base)
try:private_v4=ipaddress.ip_address(url.hostname).version==4 and ipaddress.ip_address(url.hostname).is_private
except ValueError:private_v4=False
if url.scheme!='http' or not (url.hostname in ('host.docker.internal','127.0.0.1') or private_v4):
    raise ValueError('Explicit local relay URL required')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
stopping=False
def stop(*_):
    global stopping
    stopping=True
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
def request(path, payload=None):
    if stopping: raise InterruptedError('Session cancelled')
    data=None if payload is None else json.dumps(payload).encode()
    for attempt in range(3):
        if stopping:raise InterruptedError('Session cancelled')
        req=urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json','Authorization':'Bearer '+cfg['publishKey']})
        try:
            with opener.open(req,timeout=4) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (502,503,504) or attempt==2:raise
        except (urllib.error.URLError,TimeoutError,OSError):
            if attempt==2:raise
        time.sleep(.2*(attempt+1))
def phase(name,**meta):
    print(json.dumps({'event':name,'at':time.time(),**meta}),flush=True)
    try:request('/worker',{'phase':name,**meta})
    except Exception:pass

class LiveReader:
    def __init__(self,height,width,num_frames):
        self.height,self.width,self.num_frames=height,width,num_frames
        self.sequence=-1;self.last_meta=None;self.remaining=(num_frames-1)//4+1
    def next_chunk(self):
        if stopping:raise InterruptedError('Session cancelled')
        data=request('/proxy-chunk?after='+str(self.sequence));self.sequence=data['sequence'];self.last_meta=data
        frames=[]
        take=min(3,self.remaining);self.remaining-=take
        for encoded in data['frames'][:take]:
            frame=cv2.imdecode(np.frombuffer(base64.b64decode(encoded),dtype=np.uint8),cv2.IMREAD_COLOR)
            if frame is None:raise ValueError('Invalid proxy frame')
            frame=cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)
            h,w=frame.shape[:2];cw=min(w,round(h*self.width/self.height));ch=min(h,round(w*self.height/self.width))
            frame=frame[(h-ch)//2:(h-ch)//2+ch,(w-cw)//2:(w-cw)//2+cw]
            frame=cv2.resize(frame,(self.width,self.height),interpolation=cv2.INTER_LINEAR)
            frames.append(frame)
        return torch.from_numpy(np.stack(frames)).permute(3,0,1,2)
    def close(self):pass

def live_recording(self,height,width,fps):
    self.recording_reader=LiveReader(height,width,cfg['numFrames'])
    return None,prepare_cover(cfg['anchor'],height,width),cfg['numFrames']

def live_main(self):
    self.init_run()
    total=self.scheduler.latents.shape[1];ar=self.config['ar_config'];chunk=ar['num_frame_per_chunk']
    frame_tokens=(self.input_info.latent_shape[2]//2)*(self.input_info.latent_shape[3]//2)
    pool=build_self_attn_kv_cache(self.config,ar,ar['local_attn_size']*frame_tokens,GET_DTYPE(),torch.device(AI_DEVICE));pool._init_kv_buffer()
    self.model.transformer_infer.cache_pools={True:pool}
    produced=0;started=time.perf_counter()
    try:
        for index,start in enumerate(range(0,total,chunk)):
            if stopping:raise InterruptedError('Session cancelled')
            began=time.perf_counter();frames=min(chunk,total-start)
            self._prepare_chunk_inputs(start,frames)
            self._run_steps(start,frames,total)
            self.scheduler.step_pre(self.scheduler.infer_steps-1,chunk_start=start,cache_update=True)
            self.model.infer(self.inputs)
            # Match the upstream synchronous decoder's barrier before decoding.
            torch.cuda.synchronize()
            pixels=self.vae_decoder.cached_decode_withflag(self.scheduler.latents[:,start:start+frames],start==0,start+frames==total)
            torch.cuda.synchronize();generated=time.perf_counter()
            finite=bool(torch.isfinite(pixels).all().item())
            latent_finite=bool(torch.isfinite(self.scheduler.latents[:,start:start+frames]).all().item())
            if not finite or not latent_finite:
                raise ValueError(f'Non-finite video rejected before broadcast: profile={cfg.get("profileLabel")},chunk={index},pixelsFinite={finite},latentsFinite={latent_finite}')
            # Transfer just this chunk. Do not retain GPU output for the entire session.
            values=(pixels[0].permute(1,2,3,0).float().clamp(-1,1).add(1).mul(127.5).byte().cpu().numpy())
            if values.max()==0:raise ValueError(f'All-black video rejected before broadcast: chunk={index}')
            encoded=[]
            for rgb in values:
                ok,jpeg=cv2.imencode('.jpg',cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR),[cv2.IMWRITE_JPEG_QUALITY,88])
                if not ok:raise ValueError('JPEG encoding failed')
                encoded.append(base64.b64encode(jpeg).decode())
            meta=self.recording_reader.last_meta
            request('/generated',{'profile':cfg.get('profileLabel'),'chunk':index,'inputAt':meta['inputAt'],'inputSourceMode':meta.get('sourceMode','unknown'),'inferenceMs':round((generated-began)*1000,2),'frames':encoded})
            produced+=len(encoded)
            record={'profile':cfg.get('profileLabel'),'size':cfg['size'],'chunk':index,'frames':len(encoded),'inferenceMs':round((generated-began)*1000,2),'wallMs':round((time.perf_counter()-began)*1000,2),'generatedFps':round(len(encoded)/(generated-began),2),'inputAgeMs':round(time.time()*1000-meta['inputAt']),'initialReference':bool(meta.get('initial')),'inputSourceMode':meta.get('sourceMode'),'inputCameras':meta.get('cameraFrames'),'pixelsFinite':finite,'latentsFinite':latent_finite,'meanRgb':round(float(values.mean()),2),'allocatedGiB':round(torch.cuda.memory_allocated()/1024**3,3),'reservedGiB':round(torch.cuda.memory_reserved()/1024**3,3)}
            print(json.dumps(record),flush=True)
            with Path(cfg['chunkLog']).open('a',encoding='utf-8') as f:f.write(json.dumps(record)+'\n')
            del pixels,values,encoded
        return {'frames':produced,'wallSeconds':time.perf_counter()-started}
    finally:
        self.model.transformer_infer.cache_pools={};pool=None
        self.end_run()

def main():
    if not 25<=cfg['numFrames']<=14401 or (cfg['numFrames']-1)%4:
        raise ValueError('Explicit bounded AR session required (4n+1 frames)')
    phase('loading',resolution=cfg['size'],precision='int8-convrot',t5CpuOffload=cfg.get('t5CpuOffload',True))
    profile=json.loads(Path(cfg['profile']).read_text())
    model=Path(cfg['modelRoot']);profile.update(size=cfg['size'],t5_cpu_offload=cfg.get('t5CpuOffload',True),dit_quantized_ckpt=str(model/'quantized/dit-5b-int8-convrot.safetensors'),proxy_quantized_ckpt=str(model/'quantized/proxy-dino-int8-convrot.safetensors'),t5_quantized_ckpt=str(model/'quantized/t5-fp8.safetensors'),tae_path=str(model/'decoder-5b/lighttaew2_2.pth'))
    runtime=Path(cfg['runtimeProfile']);runtime.write_text(json.dumps(profile))
    config=build_startup_config({'task':'i2v','model_cls':'wan22_edenlive_ar','model_path':str(model),'config_json':str(runtime)})
    began=time.perf_counter();runner=build_runner(config);runner.warmup()
    phase('ready',loadAndWarmupSeconds=round(time.perf_counter()-began,2),resolution=cfg['size'])
    if cfg.get('referenceReadyFile'):
        wait_seconds=cfg.get('referenceWaitSeconds')
        if not isinstance(wait_seconds,int) or not 1<=wait_seconds<=900:raise ValueError('Explicit finite reference wait required')
        torch.cuda.empty_cache()
        phase('awaiting-reference',timeoutSeconds=wait_seconds)
        deadline=time.monotonic()+wait_seconds
        receipt_file=Path(cfg['referenceReadyFile'])
        while not receipt_file.is_file():
            if stopping:raise InterruptedError('Reference wait cancelled')
            if time.monotonic()>=deadline:raise TimeoutError('Fresh paired reference was not supplied')
            time.sleep(.2)
        receipt=json.loads(receipt_file.read_text(encoding='utf-8'))
        if receipt.get('schema')!='agent-mc-render-reference/v1' or hashlib.sha256(Path(cfg['anchor']).read_bytes()).hexdigest()!=receipt.get('anchorSha256'):
            raise ValueError('Anchor does not match the fresh reference receipt')
    runner.load_recording=types.MethodType(live_recording,runner)
    runner.run_main=types.MethodType(live_main,runner)
    results=[]
    for experiment in cfg.get('experiments',[{'size':cfg['size'],'numFrames':cfg['numFrames'],'label':'default'}]):
        cfg['size'],cfg['numFrames'],cfg['profileLabel']=experiment['size'],experiment['numFrames'],experiment['label']
        phase('generating',resolution=cfg['size'],profile=cfg['profileLabel'])
        info=runner.prepare_request({'task':'i2v','prompt':cfg['prompt'],'image_path':cfg['anchor'],'video_path':cfg['anchor'],'num_frames':cfg['numFrames'],'size':cfg['size'],'seed':2026102001,'return_result_tensor':True})
        with torch.no_grad(): result=runner.run_request(info)
        results.append({'profile':cfg['profileLabel'],'size':cfg['size'],'result':result})
    phase('completed',results=results,peakAllocatedGiB=round(torch.cuda.max_memory_allocated()/1024**3,3),peakReservedGiB=round(torch.cuda.max_memory_reserved()/1024**3,3))

if __name__=='__main__':
    try:main()
    except InterruptedError:phase('cancelled')
    except Exception as e:
        phase('error',error=str(e)[:500]);raise
