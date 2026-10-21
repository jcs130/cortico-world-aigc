import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMiniMaxH3Workflow } from '../src/core/comfy-minimax-h3.ts';
import { alignComfyVideoFrames, bindComfyVideoGraph, createComfyVideoPort } from '../src/core/comfy-workflow.ts';
import { aigcDefaults } from '../src/core/providers.ts';
const models = { fl2va: 'fl.safetensors', ref2va: 'ref.safetensors', textEncoder: 'text.safetensors', videoVae: 'video.safetensors', audioVae: 'audio.safetensors', fl2vaTurboLora: 'fl8.safetensors', ref2vaTurboLora: 'ref4.safetensors' };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function provider(workflow = buildMiniMaxH3Workflow(models), http = vi.fn()) {
  const dir = mkdtempSync(join(tmpdir(), 'aigc-h3-')); dirs.push(dir);
  const file = join(dir, 'workflow.json'); writeFileSync(file, JSON.stringify(workflow));
  return createComfyVideoPort({ ...aigcDefaults().video, provider: 'comfyui-workflow', endpoint: 'http://127.0.0.1:8197', model: 'explicit-h3', workflowFile: file, maxReferences: 3 }, { fetch: http });
}
it('uses H3 native 17n+5 frames and exposes profiles/reference counts without network or downloads', () => {
  const http = vi.fn(), port = provider(undefined, http);
  expect(http).not.toHaveBeenCalled();
  expect(alignComfyVideoFrames(5, 24, { multiple: 17, offset: 5 })).toBe(124);
  expect(alignComfyVideoFrames(5, 24)).toBe(121);
  expect(port.capabilities).toMatchObject({ maxReferences: 3, referenceCounts: [0, 1, 2, 3], profiles: ['turbo', 'quality'], defaultProfile: 'turbo', parameterKeys: ['durationSec', 'seed', 'profile'] });
  expect(port.capabilities.requiredReferences).toBeUndefined();
});
it('keeps native audio, correct model/LoRA pairs and aspect-preserving references; quality removes LoRA', () => {
  const workflow = buildMiniMaxH3Workflow(models);
  const text = workflow.variants.find(v => v.profile === 'turbo' && v.requiredReferences === 0)!;
  expect(text.graph.schedule.inputs.steps).toBe(8);
  expect(text.graph.model.inputs.unet_name).toBe(models.fl2va);
  const ref = workflow.variants.find(v => v.profile === 'turbo' && v.requiredReferences === 2)!;
  expect(ref.graph.model.inputs.unet_name).toBe(models.ref2va);
  expect(ref.graph.lora.inputs.lora_name).toBe(models.ref2vaTurboLora);
  expect(ref.graph.condition.inputs).toMatchObject({ ref_image_size: 'match', 'ref_images.ref_image_1': ['image1', 0] });
  expect(ref.graph.video.inputs.audio).toEqual(['decode_audio', 0]);
  const quality = workflow.variants.find(v => v.profile === 'quality' && v.requiredReferences === 1)!;
  expect(quality.graph.lora).toBeUndefined(); expect(quality.graph.schedule.inputs.steps).toBe(20);
  const values = { prompt: '{{image0}} stays plain text', frames: 124, seed: 7, fps: 24, outputPrefix: 'out', image0: 'a.png', image1: 'b.png' };
  const graph = bindComfyVideoGraph(ref, values) as typeof ref.graph;
  expect(graph.condition.inputs.prompt).toBe(values.prompt);
  expect(graph.image1.inputs.image).toBe('b.png');
});
it('rejects undeclared profiles, duplicate variants and invalid frame grids before submission', async () => {
  const http = vi.fn(), workflow = buildMiniMaxH3Workflow(models);
  const port = provider(workflow, http);
  await expect(port.generate({ kind: 'video', prompt: 'test', references: [], requestId: 'test', parameters: { profile: 'untrusted-graph' } }, new AbortController().signal)).rejects.toThrow('workflow');
  expect(http).not.toHaveBeenCalled();
  expect(() => provider({ ...workflow, frameAlignment: { multiple: 0, offset: 5 } })).toThrow('alignment');
  expect(() => provider({ ...workflow, variants: [...workflow.variants, workflow.variants[0]] })).toThrow('duplicate');
});
it('submits exactly the selected graph and reports aligned duration while reconciling without resubmission', async () => {
  const history = { original: { status: { completed: true, status_str: 'success' }, outputs: { save: { videos: [{ filename: 'h3.mp4', subfolder: '', type: 'output' }] } } } };
  const http = vi.fn().mockResolvedValueOnce(Response.json({ prompt_id: 'original' }))
    .mockResolvedValueOnce(Response.json(history)).mockResolvedValueOnce(new Response('0000ftypisom'));
  const port = provider(undefined, http), input = { kind: 'video' as const, prompt: 'A quiet village', references: [], requestId: 'stable', parameters: { durationSec: 5, profile: 'quality' } };
  const result = await port.generate(input, new AbortController().signal);
  const graph = JSON.parse(http.mock.calls[0][1].body).prompt;
  expect(graph.condition.inputs.length).toBe(124); expect(graph.schedule.inputs.steps).toBe(20); expect(graph.lora).toBeUndefined();
  expect(result.evidence).toMatchObject({ requestedFrames: 124, effectiveDurationSec: 124 / 24, profile: 'quality', referenceCount: 0 });
  http.mockReset().mockResolvedValueOnce(Response.json(history)).mockResolvedValueOnce(new Response('0000ftypisom'));
  await port.reconcile!('original', input, new AbortController().signal);
  expect(http.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(['/history/original', '/view']);
});
