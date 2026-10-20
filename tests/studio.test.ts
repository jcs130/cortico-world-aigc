import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AigcStudio } from '../src/core/studio.ts';
import { prepareCreativeContext } from '../src/core/prompt.ts';
import { aigcDefaults } from '../src/core/providers.ts';
import { AppearanceLibrary, appearanceTool } from '../src/persona/index.ts';
import definition, { AigcWorld } from '../src/index.ts';
import type { CreationHost, GenerationPort, MediaBytes } from '../src/contracts.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6NQAAAABJRU5ErkJggg==', 'base64');
const image = { bytes: png, mime: 'image/png' };
const directories: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'aigc-')); directories.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request = { action: 'generate', kind: 'image', request_id: 'stable', prompt: 'A quiet warm village' };
const fakeHost = () => ({ blob: vi.fn(() => image), pushEvent: vi.fn(async (_event: any, _options?: any) => ({})), log: { warn: vi.fn() } }) satisfies CreationHost;
function rig(generate?: GenerationPort['generate']) {
  const provider: GenerationPort = { capabilities: { kind: 'image', provider: 'fixture', generate: true, edit: true, maxReferences: 10 },
    generate: generate ?? vi.fn(async () => ({ artifacts: [image], model: 'fixture' })) };
  const dir = directory(), host = fakeHost(), studio = new AigcStudio({ directory: dir, provider: () => provider });
  studio.start(host); return { studio, provider, host, dir };
}
async function finished(studio: AigcStudio, id: string) {
  await vi.waitFor(() => expect(studio.get(id)?.status).not.toMatch(/accepted|running/));
}
it('preserves ordered scene/identity references, raw prompt, effective prompt and generated artifact evidence', async () => {
  const r = rig();
  const refs = [{ handle: 'log:scene', role: 'scene-layout', source: { captureId: 'c1', observedAt: 'then' } },
    { handle: 'mem:self/back', role: 'identity', entityId: 'self', revision: '2', view: 'back' }];
  const accepted = await r.studio.execute({ ...request, references: refs }, { round: 18 });
  const job = JSON.parse(accepted.text); expect(job.status).toBe('accepted'); expect(job.goalCompleted).toBe(false);
  await finished(r.studio, job.id);
  const result = await r.studio.execute({ action: 'read', id: job.id });
  expect(JSON.parse(result.text)).toMatchObject({ status: 'succeeded', prompt: request.prompt,
    effectivePrompt: expect.stringContaining('Reference 2: identity'), references: [expect.objectContaining(refs[0]), expect.objectContaining(refs[1])],
    evidence: { contentApproved: false, playbackVerified: false, singingVoiceVerified: false } });
  expect(result.blobs?.[0]).toMatchObject(image);
  const inputs = await r.studio.execute({ action: 'inputs', id: job.id });
  expect(inputs.blobs).toHaveLength(2);
  expect(r.host.pushEvent.mock.calls[0]?.[1]).toEqual({ trigger: 'flush' });
  r.studio.stop();
});
it('deduplicates canonical requests and rejects changed semantics', async () => {
  const r = rig();
  const a = JSON.parse((await r.studio.execute({ ...request, parameters: { size: '1024x1024', seed: 1 } })).text);
  await finished(r.studio, a.id);
  const b = JSON.parse((await r.studio.execute({ prompt: request.prompt, request_id: 'stable', kind: 'image', action: 'generate',
    parameters: { seed: 1, size: '1024x1024' } })).text);
  expect(b.id).toBe(a.id); expect(r.provider.generate).toHaveBeenCalledTimes(1);
  expect((await r.studio.execute({ ...request, prompt: 'different' })).failed).toBe(true); r.studio.stop();
});
it('cancels waiting without cancelling the underlying generation', async () => {
  let resolve!: (r: any) => void;
  const r = rig(() => new Promise(done => { resolve = done; }));
  const accepted = JSON.parse((await r.studio.execute(request)).text);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const controller = new AbortController();
  const waiting = r.studio.execute({ action: 'wait', id: accepted.id }, { signal: controller.signal });
  controller.abort();
  expect(JSON.parse((await waiting).text)).toMatchObject({ waitCancelled: true, jobContinues: true });
  resolve({ artifacts: [image], model: 'fixture' }); await finished(r.studio, accepted.id); r.studio.stop();
});
it('ignores a late provider result after explicit cancellation', async () => {
  let resolve!: (r: any) => void;
  const r = rig(() => new Promise(done => { resolve = done; }));
  const accepted = JSON.parse((await r.studio.execute(request)).text);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const cancel = JSON.parse((await r.studio.execute({ action: 'cancel', id: accepted.id })).text);
  expect(cancel).toMatchObject({ status: 'cancelled', remoteOutcome: 'unknown' });
  resolve({ artifacts: [image], model: 'fixture' }); await new Promise(ok => setTimeout(ok, 10));
  expect(r.studio.get(accepted.id)?.status).toBe('cancelled');
  expect(r.studio.get(accepted.id)?.artifacts).toEqual([]); r.studio.stop();
});
it('stop wakes waiters and prevents late archive changes or events', async () => {
  let resolve!: (r: any) => void;
  const r = rig(() => new Promise(done => { resolve = done; }));
  const accepted = JSON.parse((await r.studio.execute(request)).text);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const waiting = r.studio.execute({ action: 'wait', id: accepted.id });
  r.studio.stop(); const stopped = readFileSync(join(r.dir, accepted.id + '.json'), 'utf8');
  expect(JSON.parse((await waiting).text).waitCancelled).toBe(true);
  resolve({ artifacts: [image], model: 'fixture' }); await new Promise(ok => setTimeout(ok, 10));
  expect(readFileSync(join(r.dir, accepted.id + '.json'), 'utf8')).toBe(stopped); expect(r.host.pushEvent).not.toHaveBeenCalled();
  expect((await r.studio.execute(request)).failed).toBe(true);
});
it('restart retains unknown submissions without replay and captures provider task id early', async () => {
  const r = rig(async input => { input.onAccepted?.('remote-original'); throw new Error('connection lost'); });
  const accepted = JSON.parse((await r.studio.execute(request)).text); await finished(r.studio, accepted.id); r.studio.stop();
  const fresh = new AigcStudio({ directory: r.dir, provider: () => { throw Error('do not reconstruct provider for replay'); } });
  fresh.start(r.host);
  const old = JSON.parse((await fresh.execute(request)).text);
  expect(old).toMatchObject({ id: accepted.id, status: 'unknown', providerRequestId: 'remote-original' }); fresh.stop();
});
it('disabled providers and metadata calls make zero network calls', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  const world = new AigcWorld(aigcDefaults); await world.start(fakeHost() as unknown as import('cortico/core/types.ts').WorldHost);
  expect(JSON.parse((await world.studio.execute({ action: 'capabilities' })).text).playback).toBe(false);
  expect((await world.studio.execute(request)).failed).toBe(true);
  expect(world.tools().map(t => t.name)).toEqual(definition.describe!.tools!.map(t => t.name));
  expect(world.envPromptVars()).toEqual({}); await world.stop(); expect(network).not.toHaveBeenCalled();
});
it('keeps Persona appearance memory explicit and revisioned across Worlds', async () => {
  let entries: any[] = [];
  const library = new AppearanceLibrary({ read: () => entries, write: value => { entries = value; } });
  library.set({ schema: 'agent-visual-reference/v1', entityId: 'self', revision: '2', label: 'Self', aliases: [], source: 'user-approved sheet',
    references: [{ handle: 'mem:self/back.png', role: 'identity', entityId: 'self', revision: '2', view: 'back' }] });
  const result = await appearanceTool(library).handler({ action: 'read', entity_id: 'self' });
  expect(result.blobs).toEqual([{ handle: 'mem:self/back.png', fallbackText: expect.stringContaining('appearance only') }]);
  expect(library.get('same-name-other-id')).toBeNull();
});
it('keeps prompt prefix stable and accounts for tools, media and output reserve', () => {
  const budget = { contextTokens: 10000, reservedOutputTokens: 1000, imageInputTokens: 500, toolDescriptions: 'tools' };
  const a = prepareCreativeContext({ intent: 'photo', references: [], facts: { camera: { pitch: 0 } } }, budget);
  const b = prepareCreativeContext({ intent: 'photo', references: [], facts: { camera: { pitch: 1 } } }, budget);
  expect(a.system).toBe(b.system); expect(a.user).not.toBe(b.user);
  expect(() => prepareCreativeContext({ intent: 'x', references: [], facts: {} }, { ...budget, contextTokens: 1000 })).toThrow('budget');
});
