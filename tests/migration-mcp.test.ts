import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AigcStudio } from '../src/core/studio.ts';
import { migrateLegacyPhotos, planLegacyPhotographyConfig } from '../src/core/migration.ts';
import { createAigcMcpServer, deliverAigcMcpEvent } from '../src/mcp/server.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6NQAAAABJRU5ErkJggg==', 'base64');
it('migrates original legacy records without source writes, overwrites, missing-output success or key-value copies', () => {
  const source = mkdtempSync(join(tmpdir(), 'aigc-legacy-')), dest = mkdtempSync(join(tmpdir(), 'aigc-dest-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111', old = { schema: 'agent-mc-photo/v1', id, action: 'create',
      phase: 'completed', prompt: 'Original exact prompt', createdAt: 'then', mime: 'image/png', providerRequestId: 'remote' };
    writeFileSync(join(source, id + '.json'), JSON.stringify(old));
    expect(migrateLegacyPhotos(source, dest).migrated).toEqual([id]);
    expect(migrateLegacyPhotos(source, dest, true).migrated).toEqual([id]);
    expect(JSON.parse(readFileSync(join(dest, id + '.json'), 'utf8'))).toMatchObject({ status: 'unknown', providerRequestId: 'remote',
      evidence: { originalRecord: old } });
    expect(migrateLegacyPhotos(source, dest, true).reused).toEqual([id]);
    expect(JSON.parse(readFileSync(join(source, id + '.json'), 'utf8'))).toEqual(old);
    expect(planLegacyPhotographyConfig({ provider: 'none', apiKey: 'must-not-copy', voxel: { radius: 2 } }))
      .toMatchObject({ credentialValuesCopied: false, minecraft: { photography: { voxel: { radius: 2 } } } });
    expect(JSON.stringify(planLegacyPhotographyConfig({ apiKey: 'must-not-copy' }))).not.toContain('must-not-copy');
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
});
it('preserves SDK/MCP job identity, binary outputs, resource lookup, original inputs and RPC/turn separation', async () => {
  const studio = new AigcStudio({ provider: () => ({
    capabilities: { kind: 'image', provider: 'fixture', generate: true, edit: true, maxReferences: 10 },
    generate: async () => ({ artifacts: [{ bytes: png, mime: 'image/png' }], model: 'fixture' }),
  }) });
  const server = createAigcMcpServer(studio, 'fixture guide'), client = new Client({ name: 'offline', version: '1' });
  const events: any[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, async notice => { events.push(notice.params.data); });
  studio.start({ blob: () => ({ bytes: png, mime: 'image/png' }), pushEvent: event => deliverAigcMcpEvent(server, event), log: { warn: () => {} } });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    expect((await client.listTools()).tools.find(t => t.name === 'aigc_query')?.annotations?.readOnlyHint).toBe(true);
    const accepted = await client.callTool({ name: 'aigc_create', arguments: { action: 'generate', kind: 'image', prompt: 'A village',
      request_id: 'one', references: [{ handle: 'mem:self', role: 'identity' }] } });
    const id = (accepted.structuredContent as any).result.id;
    const rejected = await client.callTool({ name: 'aigc_query', arguments: { action: 'cancel', id } });
    expect(rejected.isError).toBe(true);
    expect((rejected.structuredContent as any).turnEnded).toBe(false);
    expect((accepted.structuredContent as any).turnEnded).toBe(false);
    expect((accepted.structuredContent as any).goalCompleted).toBe(false);
    await studio.execute({ action: 'wait', id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ protocol: 'agent-aigc/v1', turnEnded: false, goalCompleted: false,
      event: { type: 'aigc.job', meta: { id, terminal: true } } });
    expect(events[0].artifacts[0].uri).toMatch(/^aigc:\/\/artifacts\//);
    expect(events[0].event).not.toHaveProperty('blobs');
    const read = await client.callTool({ name: 'aigc_create', arguments: { action: 'read', id } });
    expect((read.content as any[]).find(p => p.type === 'image').data).toBe(png.toString('base64'));
    const sdk = JSON.parse((await studio.execute({ action: 'read', id })).text);
    expect((read.structuredContent as any).result).toEqual(sdk);
    const resource = await client.readResource({ uri: 'aigc://artifacts/' + sdk.artifacts[0].id });
    expect((resource.contents[0] as any).blob).toBe(png.toString('base64'));
    const inputs = await client.callTool({ name: 'aigc_create', arguments: { action: 'inputs', id } });
    expect((inputs.content as any[]).some(p => p.type === 'image')).toBe(true);
    const query = await client.callTool({ name: 'aigc_query', arguments: { action: 'status', id } });
    expect((query.structuredContent as any).result).toEqual(sdk);
    await expect(client.readResource({ uri: 'other://artifacts/' + sdk.artifacts[0].id })).rejects.toThrow('Invalid AIGC');
  } finally { studio.stop(); await client.close(); await server.close(); }
});
