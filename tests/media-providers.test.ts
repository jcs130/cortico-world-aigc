import { expect, it, vi } from 'vitest';
import { createMediaPort } from '../src/core/providers.ts';
import type { GenerationInput, MediaProviderConfig } from '../src/contracts.ts';
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
