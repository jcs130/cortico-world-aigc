/** Optional loopback agent-aigc-gateway/v1 transport over the public, durable SDK.
 * No model loop, service discovery, downloads, process spawning, or global GPU interrupt.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AigcStudio, createCreationPort } from '../../dist/core/index.js';

export async function startAigcGateway({ port, directory, provider }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !directory || typeof provider !== 'function')
    throw Error('Explicit loopback port, archive directory and provider are required');
  const assets = new Map();
  const studio = new AigcStudio({ directory, provider });
  studio.start({ blob: handle => assets.get(handle) ?? null, async pushEvent() {}, log: { warn: message => console.error(message) } });
  let origin;
  const jobReceipt = job => ({
    job_id: job.id, status: job.status, model: job.model, providerRequestId: job.providerRequestId,
    remoteOutcome: job.remoteOutcome, evidence: job.evidence, reason: job.reason,
    artifacts: job.artifacts.map(a => ({ url: origin + '/artifacts/' + a.id, mime: a.mime })),
    turnEnded: false, goalCompleted: false,
  });
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Loopback host required' });
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Cross-origin access is not enabled' });
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return json(res, 403, { error: 'Loopback origin required' });
      if (req.method === 'GET' && url.pathname === '/health')
        return json(res, 200, { ok: true, schema: 'agent-aigc-gateway/v1', capabilities: studio.capabilities() });
      if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
        const media = studio.readArtifact(url.pathname.slice('/artifacts/'.length));
        if (!media) return json(res, 404, { error: 'Artifact not found' });
        res.writeHead(200, { 'content-type': media.mime, 'content-length': media.bytes.length, 'x-content-type-options': 'nosniff' });
        res.end(media.bytes); return;
      }
      const match = /^\/jobs\/([a-f0-9-]{36})(?:\/(cancel|reconcile))?$/.exec(url.pathname);
      if (match && req.method === 'GET' && !match[2]) {
        const job = studio.get(match[1]);
        return job ? json(res, 200, jobReceipt(job)) : json(res, 404, { error: 'Job not found' });
      }
      if (match && req.method === 'POST' && match[2]) {
        const result = await studio.execute({ action: match[2], id: match[1] });
        let job; try { job = JSON.parse(result.text); } catch {}
        if (!job?.id || !studio.get(job.id)) return json(res, 409, { error: result.text });
        return json(res, 200, jobReceipt(job));
      }
      if (req.method !== 'POST' || url.pathname !== '/jobs') return json(res, 404, { error: 'Unknown route' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 48 * 1024 * 1024) throw Error('Request exceeds 48 MiB');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.schema !== 'agent-aigc-gateway/v1' || typeof body.request_id !== 'string' ||
        !body.request_id || body.request_id.length > 256 || !Array.isArray(body.references) || body.references.length > 14)
        throw Error('Invalid gateway request');
      const selected = provider(body.kind);
      if (!selected || body.model !== selected.capabilities.model) throw Error('Model is not explicitly configured');
      const requestHash = createHash('sha256').update(body.request_id).digest('hex');
      const handles = [];
      try {
        const references = body.references.map((ref, i) => {
          if (typeof ref.data !== 'string' || ref.data.length > 16 * 1024 * 1024) throw Error('Invalid base64 reference');
          const bytes = Buffer.from(ref.data, 'base64');
          if (bytes.toString('base64') !== ref.data) throw Error('Invalid base64 reference');
          if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw Error('Reference hash mismatch');
          const handle = requestHash + ':' + i;
          handles.push(handle); assets.set(handle, { bytes, mime: ref.mime });
          return { handle, role: ref.role };
        });
        const outcome = await studio.execute({ action: 'generate', kind: body.kind, request_id: body.request_id,
          prompt: body.prompt, parameters: body.parameters, references });
        let job; try { job = JSON.parse(outcome.text); } catch {}
        if (!job?.id || !studio.get(job.id)) return json(res, 409, { error: outcome.text });
        return json(res, 202, jobReceipt(job));
      } finally { handles.forEach(handle => assets.delete(handle)); }
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'Request failed' }); else res.destroy(); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, studio, close: async () => { studio.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw Error('Usage: node providers/comfyui/gateway.mjs <explicit-config.json>');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const gateway = await startAigcGateway({ port: config.port, directory: config.directory,
    provider: kind => createCreationPort(kind, config.aigc) });
  console.log(JSON.stringify({ ready: true, origin: gateway.origin, schema: 'agent-aigc-gateway/v1' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void gateway.close(); });
}
