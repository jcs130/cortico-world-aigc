import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AigcStudio } from '../core/studio.ts';
import { AIGC_TOOL_DECLS } from '../tools.ts';
import type { CreationEvent } from '../contracts.ts';
const uri = (id: string) => 'aigc://artifacts/' + id;
/** MCP transports the same event evidence; large media remain retrievable resources. */
export async function deliverAigcMcpEvent(server: Server, event: CreationEvent): Promise<void> {
  let job: Record<string, unknown> = {};
  try { job = JSON.parse(event.text); } catch { /* Original text remains in event. */ }
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts.map(a => ({ ...a, uri: uri(a.id) })) : [];
  const { blobs: _binary, ...metadata } = event;
  await server.notification({ method: 'notifications/message', params: {
    level: 'info', logger: 'agent-aigc/v1', data: { protocol: 'agent-aigc/v1', event: metadata,
      artifacts, turnEnded: false, goalCompleted: false },
  } });
}
/** Host supplies references explicitly. MCP does not automatically inherit Persona blobs. */
export function createAigcMcpServer(studio: AigcStudio, guide: string) {
  const server = new Server({ name: 'agent-aigc', version: '0.1.0' }, { capabilities: { tools: {}, resources: {}, logging: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AIGC_TOOL_DECLS.map(d => ({
    name: d.name, description: d.description, inputSchema: d.parameters,
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'aigc_help') return { content: [{ type: 'text', text: guide }] };
    if (request.params.name !== 'aigc_create') return { isError: true, content: [{ type: 'text', text: 'Unknown AIGC tool' }] };
    const outcome = await studio.execute(request.params.arguments ?? {}, { signal: extra.signal });
    let data: any;
    try { data = JSON.parse(outcome.text); } catch { data = { error: outcome.text }; }
    const content: any[] = [{ type: 'text', text: outcome.text }];
    for (const b of outcome.blobs ?? []) {
      if ('bytes' in b && b.mime.startsWith('image/')) content.push({ type: 'image', data: Buffer.from(b.bytes).toString('base64'), mimeType: b.mime });
      else if ('bytes' in b && b.mime.startsWith('audio/')) content.push({ type: 'audio', data: Buffer.from(b.bytes).toString('base64'), mimeType: b.mime });
    }
    for (const a of data.artifacts ?? []) content.push({ type: 'resource_link', uri: uri(a.id), name: a.name, mimeType: a.mime });
    return { content, structuredContent: { protocol: 'agent-aigc/v1', result: data, turnEnded: false, goalCompleted: false },
      ...(outcome.failed ? { isError: true } : {}) };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: studio.list().flatMap(j => j.artifacts.map(a => ({ uri: uri(a.id), name: a.name, mimeType: a.mime }))),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const id = request.params.uri.replace(/^aigc:\/\/artifacts\//, '');
    const asset = studio.readArtifact(id);
    if (!asset) throw new Error('AIGC artifact not found');
    return { contents: [{ uri: uri(id), mimeType: asset.mime, blob: Buffer.from(asset.bytes).toString('base64') }] };
  });
  return server;
}
