import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
async function waitFor(fn:()=>void){for(let n=0;;n++){try{fn();return;}catch(e){if(n>200)throw e;await delay(10);}}}
import { Core } from 'cortico/core/core.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import { createResponse } from 'cortico/protocol/open-responses/index.ts';
import { functionCall, message } from 'cortico/protocol/open-responses/context.ts';
import { unknownMeters } from 'cortico/core/generation.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import type { World, WorldHost, Persona } from 'cortico/core/types.ts';
import { AigcWorld } from '../../src/index.ts';
import { aigcDefaults } from '../../src/core/providers.ts';
import { AppearanceLibrary, appearanceTool } from '../../src/persona/index.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6NQAAAABJRU5ErkJggg==', 'base64');
async function main(){
  const directory = mkdtempSync(join(tmpdir(), 'aigc-official-flow-'));
  let captureHost!: WorldHost, deliveryHost!: WorldHost;
  let delivered = 0, turnEnds = 0, stage = 0;
  const originalFetch=globalThis.fetch;let fetchCalls=0;
  globalThis.fetch=async (url,init)=>{fetchCalls++;
    assert.equal(String(url),'https://fixture.invalid/images');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.image.length,2);assert.match(body.prompt,/Reference 2: identity/);
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  };
  const capture: World = { id: 'mc', envPromptVars: () => null,
    start: async host => { captureHost = host; }, stop: async () => {},
    tools: () => [{ name: 'mc_photo', description: 'Offline original capture fixture', tags: ['read'], barrierAfter: true,
      parameters: { type: 'object', properties: {} }, handler: async () => ({
        text: JSON.stringify({ captureId: 'original', camera: { yawRad: 0, pitchRad: 0 }, historical: true }),
        blobs: [{ bytes: png, mime: 'image/png', fallbackText: 'Original scene reference.' }],
      }) }] };
  const delivery: World = { id: 'delivery', envPromptVars: () => null,
    start: async host => { deliveryHost = host; }, stop: async () => {},
    tools: () => [{ name: 'delivery_send', description: 'Delivery fixture', tags: ['speak'],
      parameters: { type: 'object', properties: {} }, handler: async args => {
        assert.deepEqual(deliveryHost.blob(String(args.handle))?.bytes,png); delivered++; return 'sent';
      } }] };
  const config = aigcDefaults();
  config.image = { ...config.image, provider: 'volcengine', endpoint: 'https://fixture.invalid/images',
    apiKeyEnv: 'FIXTURE_KEY', model: 'fixture', maxReferences: 10 };
  const art = new AigcWorld(() => config, join(directory, 'aigc'), () => 'fixture-key');
  const appearance = appearanceTool(new AppearanceLibrary({
    read: () => [{ schema: 'agent-visual-reference/v1', entityId: 'self', revision: '1', label: 'Self', aliases: [], source: 'fixture',
      references: [{ handle: 'mem:self/front', role: 'identity', entityId: 'self', revision: '1', view: 'front' }] }],
    write: () => { throw Error('This test never writes Persona memory'); },
  }));
  const worlds = [capture, art, delivery];
  const persona: Persona = {
    memoryDir: join(directory, 'memory'), attach: () => {},
    blobs: { put: () => { throw Error('No Persona writes'); }, get: handle => handle === 'mem:self/front' ? { bytes: png, mime: 'image/png' } : null, list: () => [] },
    systemSegments: async () => [{ title: 'fixture', text: 'Choose tools and explicit references.' }],
    onTurnEnded: () => { turnEnds++; },
    declareSessions: () => [{ id: 'main', label: 'main', persistent: true, receivesEvents: true,
      rounds: () => ({ soft: 8, hard: 12 }), tools: () => [appearance, ...worlds.flatMap(w => w.tools())] }],
  };
  const llm: ResponseClient = { respond: async (request, options) => {
    stage++;
    const ctx = options?.context ?? [], call = (name: string, args: unknown) => functionCall('call-' + stage, name, JSON.stringify(args)).item;
    const response = createResponse('response-' + stage, request);
    const resultFor = (name: string) => {
      const c = ctx.filter(r => r.item.type === 'function_call' && r.item.name === name).at(-1)!.item as any;
      return ctx.find(r => r.item.type === 'function_call_output' && r.item.call_id === c.call_id)!;
    };
    if (stage === 1) response.output = [functionCall('appearance', 'appearance_lookup', '{"action":"read","entity_id":"self"}').item, call('mc_photo', {})] as any;
    else if (stage === 2) {
      assert.equal(turnEnds,0);
      const scene = resultFor('mc_photo').context.blobs![0]!.handle;
      response.output = [call('aigc_create', { action: 'generate', kind: 'image', prompt: 'Preserve the level camera and original scene.',
        request_id: 'one-render', references: [{ handle: scene, role: 'scene-layout' },
          { handle: 'mem:self/front', role: 'identity', entityId: 'self', revision: '1' }] })] as any;
    } else if (stage === 3) {
      const accepted = JSON.parse(String((resultFor('aigc_create').item as any).output).split('\n')[0]);
      await waitFor(()=>assert.equal(art.studio.get(accepted.id)?.status,'succeeded'));
      response.output = [call('aigc_create', { action: 'read', id: accepted.id })] as any;
    } else if (stage === 4) {
      const result = resultFor('aigc_create');
      assert.equal(JSON.parse(String((result.item as any).output).split('\n')[0]).status,'succeeded');
      response.output = [call('delivery_send', { handle: result.context.blobs![0]!.handle })] as any;
    } else response.output = [message('assistant', 'Done.').item] as any;
    response.status = 'completed';
    const origin = { instance: 'fixture', module: 'fixture', model: 'fixture', compatibilityDomain: 'fixture' };
    return { response, origin, attempts: [{ id: String(stage), generationId: response.id, ordinal: 1, origin,
      startedAt: new Date().toISOString(), elapsedMs: 0, requestId: null, responseId: response.id,
      outcome: 'completed', status: 200, serviceTier: null, meters: unknownMeters(), charges: [] }] };
  } };
  const cfg = { ...structuredClone(CORE_DEFAULTS), displayName: 'fixture',
    providers: { fixture: { kind: 'openai-responses-compat', baseUrl: 'https://unused.invalid', spec: { model: 'fixture', thinking: false } } },
    activeProvider: 'fixture', logging: { file: 'debug' as const, stdout: 'error' as const, areas: '' } };
  const core = new Core({ config: cfg, secret: () => '', rootDir: directory,
    dataDir: join(directory, 'data'), memoryDir: persona.memoryDir }, { persona, worlds, llm });
  try {
    await core.start();
    await captureHost.pushEvent({ type: 'mc.request', source: 'mc', ts: new Date().toISOString(), text: 'Create one enhanced photo.' }, { trigger: 'flush' });
    await waitFor(()=>{assert.equal(delivered,1);assert.ok(turnEnds>=1);});
    assert.equal(fetchCalls,1);
    assert.ok(core.store.range({}).some(e=>e.type==='aigc.job'));
    console.log(JSON.stringify({passed:true,delivered,modelCalls:'scripted only',providerCalls:fetchCalls,actualNetworkCalls:0}));
  } finally { await core.stop(); globalThis.fetch=originalFetch; rmSync(directory, { recursive: true, force: true }); }
}
await main();
