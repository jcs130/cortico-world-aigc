import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAigcGateway } from '../providers/comfyui/gateway.mjs';
it('keeps acceptance, original task identity, duplicate requests, cancellation and restart distinct from completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigc-http-'));
  const generate = vi.fn(async (input, signal) => {
    input.onAccepted('native-original');
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  });
  const provider = () => ({ capabilities: { kind: 'video', generate: true, edit: false, maxReferences: 0, model: 'h3-test', provider: 'test', instanceId: 'same' }, generate });
  let gateway = await startAigcGateway({ port: 0, directory, provider });
  const submit = (requestId = 'stable') => fetch(gateway.origin + '/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'agent-aigc-gateway/v1', kind: 'video', model: 'h3-test', request_id: requestId, prompt: 'test', parameters: {}, references: [] }) }).then(r => r.json());
  try {
    const job = await submit();
    expect(job).toMatchObject({ goalCompleted: false, turnEnded: false });
    expect((await submit()).job_id).toBe(job.job_id);
    expect(generate).toHaveBeenCalledOnce();
    const current = await (await fetch(gateway.origin + '/jobs/' + job.job_id)).json();
    expect(current.providerRequestId).toBe('native-original');
    await gateway.close();
    gateway = await startAigcGateway({ port: 0, directory, provider });
    const recovered = await submit();
    expect(recovered).toMatchObject({ job_id: job.job_id, status: 'unknown', providerRequestId: 'native-original' });
    expect(generate).toHaveBeenCalledOnce();
    const next = await submit('cancel-me');
    const cancelled = await (await fetch(gateway.origin + '/jobs/' + next.job_id + '/cancel', { method: 'POST' })).json();
    expect(cancelled).toMatchObject({ status: 'cancelled', remoteOutcome: 'unknown', goalCompleted: false });
    expect((await submit('cancel-me')).status).toBe('cancelled');
    expect(generate).toHaveBeenCalledTimes(2);
    const rejected = await fetch(gateway.origin + '/jobs', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: '{}' });
    expect(rejected.status).toBe(403);
  } finally { await gateway.close(); rmSync(directory, { recursive: true, force: true }); }
});
