import { expect, it, vi } from 'vitest';
import { createMediaPort } from '../src/core/providers.ts';
import type { GenerationInput, MediaProviderConfig } from '../src/contracts.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const config: MediaProviderConfig = { provider: 'gateway', endpoint: 'https://fixture.invalid/base/', model: 'fixture',
  apiKeyEnv: 'FIXTURE_KEY', timeoutMs: 1000, pollMs: 50, resultHosts: ['files.invalid'], maxReferences: 0 };
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom00000000')]);
const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
const input = (kind: 'video' | 'music'): GenerationInput => ({ kind, prompt: 'Original cinematic scene', requestId: 'original',
  parameters: kind === 'music' ? { instrumental: true } : { durationSec: 5 }, references: [] });
it('submits Wan2.7 once, preserves native task id, disables prompt extension, and downloads without auth', async () => {
  const http = vi.fn().mockResolvedValueOnce(Response.json({ output: { task_id: 'wan-original' } }))
    .mockResolvedValueOnce(Response.json({ output: { task_status: 'SUCCEEDED', video_url: 'https://files.invalid/out.mp4' } }))
    .mockResolvedValueOnce(new Response(mp4));
  const accepted = vi.fn();
  const port = createMediaPort('video', { ...config, provider: 'bailian-wan27', model: 'wan2.7-t2v-2026-06-12',
    endpoint: 'https://fixture.invalid/api/v1/services/aigc/video-generation/video-synthesis' }, { fetch: http, env: { FIXTURE_KEY: 'fixture' } })!;
  expect(http).not.toHaveBeenCalled();
  const result = await port.generate({ ...input('video'), onAccepted: accepted }, new AbortController().signal);
  expect(result.providerRequestId).toBe('wan-original'); expect(accepted).toHaveBeenCalledWith('wan-original');
  expect(JSON.parse(http.mock.calls[0][1].body).parameters.prompt_extend).toBe(false);
  expect(http.mock.calls[0][1].headers['X-DashScope-Async']).toBe('enable');
  expect(String(http.mock.calls[1][0])).toBe('https://fixture.invalid/api/v1/tasks/wan-original');
  expect(http.mock.calls[2][1].headers).toBeUndefined();
});
it('snapshots provider settings and retains explicit terminal receipts from the original task', async () => {
  const settings = { ...config, provider: 'bailian-wan27' as const, model: 'wan2.7-t2v-original' };
  const http = vi.fn().mockResolvedValueOnce(Response.json({ output: { task_id: 'original-task' } }))
    .mockResolvedValueOnce(Response.json({ output: { task_status: 'FAILED' } }));
  const port = createMediaPort('video', settings, { fetch: http, env: { FIXTURE_KEY: 'fixture' } })!;
  settings.model = 'new-settings'; settings.endpoint = 'https://another.invalid';
  await expect(port.generate(input('video'), new AbortController().signal)).rejects.toMatchObject({
    providerRequestId: 'original-task', terminalStatus: 'failed', evidence: { providerState: 'FAILED' },
  });
  expect(JSON.parse(http.mock.calls[0][1].body).model).toBe('wan2.7-t2v-original');
  expect(String(http.mock.calls[0][0])).toBe(config.endpoint); expect(http).toHaveBeenCalledTimes(2);
});
it('uses native FAL music queue without automatic lyric writing or a singer identity claim', async () => {
  const http = vi.fn().mockResolvedValueOnce(Response.json({ request_id: 'music-original',
    status_url: 'https://fixture.invalid/requests/music-original/status', response_url: 'https://fixture.invalid/requests/music-original' }))
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' })).mockResolvedValueOnce(Response.json({ audio: { url: 'https://files.invalid/song.wav' } }))
    .mockResolvedValueOnce(new Response(wav));
  const port = createMediaPort('music', { ...config, provider: 'fal-music' }, { fetch: http, env: { FIXTURE_KEY: 'fixture' } })!;
  const result = await port.generate(input('music'), new AbortController().signal);
  expect(result.artifacts[0]?.mime).toBe('audio/wav');
  expect(JSON.parse(http.mock.calls[0][1].body)).toMatchObject({ is_instrumental: true, lyrics_optimizer: false });
  expect(result.evidence?.singerIdentityVerified).toBe(false);
});
it('keeps generic gateway prefixes and rejects unexpected download hosts', async () => {
  const http = vi.fn().mockResolvedValueOnce(Response.json({ job_id: 'owned', status: 'succeeded',
    artifacts: [{ url: 'https://unconfigured.invalid/output.mp4', mime: 'video/mp4' }] }));
  const port = createMediaPort('video', config, { fetch: http, env: { FIXTURE_KEY: 'fixture' } })!;
  await expect(port.generate(input('video'), new AbortController().signal)).rejects.toThrow('explicitly configured');
  expect(String(http.mock.calls[0][0])).toBe('https://fixture.invalid/base/jobs'); expect(http).toHaveBeenCalledOnce();
});
it.each([['files.invalid'], 'files.invalid,127.0.0.1'])('accepts legacy SDK and editable host lists: %s', async resultHosts => {
  const http = vi.fn().mockResolvedValueOnce(Response.json({ job_id: 'owned', status: 'succeeded',
    artifacts: [{ url: 'https://files.invalid/output.mp4', mime: 'video/mp4' }] }))
    .mockResolvedValueOnce(new Response(mp4));
  const port = createMediaPort('video', { ...config, resultHosts: resultHosts as string | string[] }, { fetch: http, env: { FIXTURE_KEY: 'fixture' } })!;
  expect((await port.generate(input('video'), new AbortController().signal)).providerRequestId).toBe('owned');
  expect(http.mock.calls[1][1].headers).toBeUndefined();
});
it('retrieves a retained original YuE candidate explicitly without declaring lyrics approved or regenerating',async()=>{
 const root=mkdtempSync(join(tmpdir(),'yue-artifact-'));
 try{
  mkdirSync(join(root,'original'));writeFileSync(join(root,'original','song.wav'),wav);
  const http=vi.fn().mockResolvedValueOnce(Response.json({jobId:'original',state:'failed'}));
  const port=createMediaPort('music',{...config,provider:'yue-gateway',artifactDirectory:root},{fetch:http,env:{FIXTURE_KEY:'fixture'}})!;
  const result=await port.generate({...input('music'),parameters:{instrumental:true,durationSec:30}},new AbortController().signal);
  expect(result.artifacts[0].bytes).toEqual(wav);
  expect(result.evidence).toMatchObject({upstreamState:'failed',retainedCandidate:true,contentApproved:false,lyricsVerified:false,adoptionRequired:true});
  expect(http).toHaveBeenCalledOnce();
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('reconciles a gateway task through GET only',async()=>{
 const http=vi.fn().mockResolvedValueOnce(Response.json({job_id:'original',status:'succeeded',artifacts:[{url:'https://files.invalid/out.mp4',mime:'video/mp4'}]}))
  .mockResolvedValueOnce(new Response(mp4));
 const port=createMediaPort('video',config,{fetch:http,env:{FIXTURE_KEY:'fixture'}})!;
 expect((await port.reconcile!('original',input('video'),new AbortController().signal)).providerRequestId).toBe('original');
 expect(http.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
 expect(http.mock.calls.map(([url])=>new URL(url).pathname)).toEqual(['/base/jobs/original','/out.mp4']);
});
it('preserves bounded validation diagnostics without copying arbitrary provider error text',async()=>{
 const http=vi.fn().mockResolvedValueOnce(Response.json({jobId:'original',state:'failed',failureCode:'asr_process_failed',validationPhase:'asr',validationExitCode:7,error:'private credential must not propagate'}));
 const port=createMediaPort('music',{...config,provider:'yue-gateway'},{fetch:http,env:{FIXTURE_KEY:'fixture'}})!;
 await expect(port.generate({...input('music'),parameters:{instrumental:true,durationSec:30}},new AbortController().signal)).rejects.toMatchObject({
  evidence:{providerState:'failed',failureCode:'asr_process_failed',validationPhase:'asr',validationExitCode:7}
 });
});
