import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CreationJob, ImageProviderConfig } from '../contracts.ts';
import { AIGC_PROTOCOL } from '../contracts.ts';
import { IMAGE_PROVIDER_DEFAULTS } from './image-generation.ts';
import { validateMedia, extension } from './media.ts';

/** Offline explicit operator migration. Never invoked by World startup or a model tool. */
export function migrateLegacyPhotos(sourceDirectory: string, destinationDirectory: string, apply = false) {
  const report = { schema: 'agent-aigc-legacy-migration/v1', apply, migrated: [] as string[], reused: [] as string[], skippedCaptures: 0 };
  for (const file of readdirSync(sourceDirectory).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
    const raw = readFileSync(join(sourceDirectory, file));
    const old = JSON.parse(raw.toString('utf8'));
    if (old.schema !== 'agent-mc-photo/v1' || file !== old.id + '.json') continue;
    if (old.action === 'capture') { report.skippedCaptures++; continue; }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const target = join(destinationDirectory, file);
    if (existsSync(target)) {
      if (JSON.parse(readFileSync(target, 'utf8')).legacy?.sourceSha256 !== sha256) throw new Error('Migration destination contains a different job with the same id');
      report.reused.push(old.id); continue;
    }
    const job: CreationJob = { schema: AIGC_PROTOCOL, id: old.id, requestId: 'legacy-mc-photo:' + old.id,
      signature: sha256, kind: 'image', prompt: old.prompt ?? '', parameters: { size: old.size },
      references: [], status: old.phase === 'completed' ? 'succeeded' : old.phase === 'cancelled' ? 'cancelled' : 'unknown',
      createdAt: old.createdAt, updatedAt: new Date().toISOString(), provider: 'legacy-import',
      model: old.model, providerRequestId: old.providerRequestId, artifacts: [], usage: old.usage, goalCompleted: false,
      legacy: { schema: old.schema, id: old.id, sourceSha256: sha256 },
      evidence: { originalRecord: old, originalReferenceBytesRecovered: false, contentApproved: false, playbackVerified: false } };
    const imageFile = join(sourceDirectory, old.id + '.image');
    let image: Buffer | undefined;
    if (existsSync(imageFile)) {
      if (statSync(imageFile).size > 24 * 1024 * 1024) throw new Error('Legacy image exceeds migration limit');
      image = readFileSync(imageFile);
      validateMedia({ bytes: image, mime: old.mime }, 'image');
      const id = old.id + '-output-0';
      job.artifacts.push({ id, bytes: image.length, mime: old.mime, name: id + extension(old.mime),
        sha256: createHash('sha256').update(image).digest('hex') });
    } else if (job.status === 'succeeded') {
      job.status = 'unknown'; job.reason = 'Legacy success receipt exists but original output bytes are unavailable';
    }
    if (apply) {
      mkdirSync(destinationDirectory, { recursive: true });
      if (image) writeFileSync(join(destinationDirectory, old.id + '-output-0.media'), image);
      writeFileSync(target + '.tmp', JSON.stringify(job)); renameSync(target + '.tmp', target);
    }
    report.migrated.push(old.id);
  }
  return report;
}
export function planLegacyPhotographyConfig(legacy: Record<string, unknown>) {
  const image: ImageProviderConfig = { ...structuredClone(IMAGE_PROVIDER_DEFAULTS) };
  for (const key of ['provider', 'endpoint', 'model', 'apiKeyEnv', 'generate', 'edit', 'maxReferences', 'timeoutMs', 'resultHosts', 'flux3'] as const)
    if (legacy[key] !== undefined) (image as any)[key] = structuredClone(legacy[key]);
  return { schema: 'agent-aigc-config-migration/v1', aigc: { image },
    minecraft: { photography: legacy.voxel ? { voxel: structuredClone(legacy.voxel) } : {} },
    credentialValuesCopied: false, reloadPerformed: false };
}
