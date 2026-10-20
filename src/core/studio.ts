import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CreationCallContext, CreationHost, CreationJob, CreationKind, CreationOutcome, CreationRequest,
  MediaBytes, ResolvedReference, StudioOptions, JobStatus,
} from '../contracts.ts';
import { AIGC_PROTOCOL } from '../contracts.ts';
import { ImageGenerationError } from './image-generation.ts';
import { extension, validateMedia } from './media.ts';
import { withReferenceRoles } from './prompt.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const ID = /^[a-f0-9-]{36}$/;
const terminal = (s: JobStatus) => !['accepted', 'running'].includes(s);
interface Active { controller: AbortController; done: Promise<void> }

/** Explicit creation jobs; never a Persona, autonomous planner, game client or player. */
export class AigcStudio {
  private host: CreationHost | null = null;
  private epoch = 0;
  private lifetime = new AbortController();
  private readonly jobs = new Map<string, CreationJob>();
  private readonly assets = new Map<string, MediaBytes>();
  private readonly active = new Map<string, Active>();
  constructor(private readonly options: StudioOptions) {
    if (!Number.isInteger(options.maxConcurrent ?? 1) || (options.maxConcurrent ?? 1) < 1) throw new Error('Invalid creation concurrency');
    if (options.directory) {
      mkdirSync(options.directory, { recursive: true });
      for (const file of readdirSync(options.directory).filter(f => ID.test(f.slice(0, -5)) && f.endsWith('.json'))) {
        const job = JSON.parse(readFileSync(join(options.directory, file), 'utf8')) as CreationJob;
        if (job.schema !== AIGC_PROTOCOL || file !== job.id + '.json') continue;
        if (!terminal(job.status)) {
          job.status = 'unknown'; job.remoteOutcome = 'unknown';
          job.reason = 'Previous process stopped before terminal evidence. Reconcile the original provider request; do not resubmit.';
        }
        this.save(job);
      }
    }
  }
  start(host: CreationHost): void {
    if (this.host) throw new Error('AIGC studio already started');
    if (this.active.size) throw new Error('Previous provider requests are still draining');
    this.host = host; this.epoch++; this.lifetime = new AbortController();
  }
  stop(): void {
    this.host = null; this.epoch++; this.lifetime.abort(new Error('AIGC World stopped'));
    for (const [id, active] of this.active) {
      active.controller.abort(new Error('AIGC World stopped'));
      const job = this.jobs.get(id)!;
      if (!terminal(job.status)) {
        job.status = 'unknown'; job.remoteOutcome = 'unknown';
        job.reason = 'Local World stopped. Remote computation may continue; reconcile original request.';
        this.save(job);
      }
    }
  }
  private save(job: CreationJob): void {
    job.updatedAt = new Date().toISOString();
    if (this.options.directory) {
      const file = join(this.options.directory, job.id + '.json');
      writeFileSync(file + '.tmp', JSON.stringify(job)); renameSync(file + '.tmp', file);
    }
    this.jobs.set(job.id, job);
  }
  private saveAsset(id: string, asset: MediaBytes): void {
    if (this.options.directory) writeFileSync(join(this.options.directory, id + '.media'), asset.bytes);
    else this.assets.set(id, { bytes: Uint8Array.from(asset.bytes), mime: asset.mime });
  }
  private asset(id: string, mime: string): MediaBytes | null {
    if (!/^[a-f0-9-]{36}(?:-(?:input|output)-\d{1,2})?$/.test(id)) return null;
    if (!this.options.directory) return this.assets.get(id) ?? null;
    const path = join(this.options.directory, id + '.media');
    return existsSync(path) ? { bytes: readFileSync(path), mime } : null;
  }
  private outcome(job: CreationJob, include = false): CreationOutcome {
    const blobs = include ? job.artifacts.map(a => {
      const asset = this.asset(a.id, a.mime);
      if (!asset || hash(asset.bytes) !== a.sha256) throw new Error('Archived artifact missing or changed');
      return { ...asset, name: a.name, fallbackText: 'Generated ' + job.kind + ' from job ' + job.id + '; historical artifact, not current-world evidence or playback.' };
    }) : [];
    return { text: JSON.stringify(job), ...(blobs.length ? { blobs } : {}),
      ...(['failed', 'unknown'].includes(job.status) ? { failed: true as const } : {}) };
  }
  get(id: string): CreationJob | undefined { const row = this.jobs.get(id); return row ? structuredClone(row) : undefined; }
  list(): CreationJob[] { return [...this.jobs.values()].slice(-50).map(j => structuredClone(j)); }
  readArtifact(id: string): MediaBytes | null {
    for (const job of this.jobs.values()) {
      const a = job.artifacts.find(a => a.id === id);
      if (a) {
        const bytes = this.asset(id, a.mime);
        if (!bytes || hash(bytes.bytes) !== a.sha256) throw new Error('Artifact integrity failure');
        return bytes;
      }
    }
    return null;
  }
  capabilities() {
    return { schema: AIGC_PROTOCOL, kinds: Object.fromEntries((['image', 'video', 'music'] as const)
      .map(kind => [kind, this.options.provider(kind)?.capabilities ?? { kind, available: false }])),
      planner: 'Persona', identityLibrary: 'Persona Memory', playback: false, defaultEnhancement: false,
      maxConcurrent: this.options.maxConcurrent ?? 1 };
  }
  private cancel(job: CreationJob): void {
    if (terminal(job.status)) return;
    this.active.get(job.id)?.controller.abort(new Error('Creation cancelled locally'));
    job.status = 'cancelled'; job.remoteOutcome = 'unknown';
    job.reason = 'Local request cancelled; remote computation/billing may continue. No global interrupt sent.';
    this.save(job);
  }
  async execute(args: Record<string, unknown>, ctx: CreationCallContext = {}): Promise<CreationOutcome> {
    const host = this.host, epoch = this.epoch;
    if (!host) return { text: 'AIGC studio is stopped', failed: true };
    try {
      ctx.signal?.throwIfAborted();
      if (args.action === 'capabilities') return { text: JSON.stringify(this.capabilities()) };
      if (args.action === 'list') return { text: JSON.stringify(this.list()) };
      if (['status', 'read', 'wait', 'cancel', 'inputs'].includes(String(args.action))) {
        let job = this.jobs.get(String(args.id));
        if (!job) throw new Error('Creation job not found');
        if (args.action === 'cancel') this.cancel(job);
        if (args.action === 'wait' && !terminal(job.status)) {
          const waitMs = args.timeout_ms ?? 30000;
          if (!Number.isInteger(waitMs) || Number(waitMs) < 1 || Number(waitMs) > 60000) throw new Error('Wait timeout must be 1..60000ms');
          const signal = AbortSignal.any([this.lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          let abort: (() => void) | undefined;
          const cancelled = new Promise<'cancelled'>(resolve => {
            abort = () => resolve('cancelled');
            signal?.addEventListener('abort', abort, { once: true });
          });
          try {
            const result = await Promise.race([this.active.get(job.id)?.done,
              cancelled, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Number(waitMs)); })]);
            if (result === 'cancelled') return { text: JSON.stringify({ waitCancelled: true, jobContinues: !terminal(job.status), job }) };
          } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
          job = this.jobs.get(job.id)!;
        }
        if (args.action === 'inputs') {
          return { text: JSON.stringify({ schema: AIGC_PROTOCOL, id: job.id, prompt: job.prompt, parameters: job.parameters, references: job.references }),
            blobs: job.references.map((ref, i) => {
              const asset = this.asset(job!.id + '-input-' + i, ref.mime);
              if (!asset || hash(asset.bytes) !== ref.sha256) throw new Error('Original reference missing or changed');
              return { ...asset, fallbackText: 'Original ' + ref.role + ' reference; historical input.' };
            }) };
        }
        return this.outcome(job, args.action === 'read');
      }
      if (args.action !== 'generate') throw new Error('Unknown AIGC action');
      const kind = args.kind as CreationKind;
      if (!['image', 'video', 'music'].includes(kind)) throw new Error('Creation kind must be image, video or music');
      if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 16000) throw new Error('Explicit prompt required, at most 16000 characters');
      const requestId = args.request_id ?? ctx.callId;
      if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new Error('Stable request_id or tool call id required');
      const signature = hash(canonical({ ...args, request_id: undefined }));
      const previous = [...this.jobs.values()].find(j => j.requestId === requestId);
      if (previous) {
        if (previous.signature !== signature) throw new Error('Request id reused with different arguments');
        return this.outcome(previous, previous.status === 'succeeded');
      }
      if (this.active.size >= (this.options.maxConcurrent ?? 1)) throw new Error('Creation provider is busy or draining; query the original job first');
      const provider = this.options.provider(kind);
      if (!provider || !provider.capabilities.generate) throw new Error('No explicitly configured provider for ' + kind + '; ordinary game screenshots remain available');
      const refs = args.references ?? [];
      if (!Array.isArray(refs) || refs.length > provider.capabilities.maxReferences) throw new Error('Too many references for this provider');
      if (args.parameters !== undefined && (!args.parameters || typeof args.parameters !== 'object' || Array.isArray(args.parameters))) throw new Error('parameters must be an object');
      const resolved: ResolvedReference[] = refs.map((ref: unknown) => {
        if (!ref || typeof ref !== 'object') throw new Error('Reference needs handle and explicit role');
        const r = ref as ResolvedReference;
        if (typeof r.handle !== 'string' || r.handle.length > 512
          || !['edit-target', 'scene-layout', 'identity', 'style', 'motion', 'audio'].includes(r.role)) throw new Error('Reference needs handle and explicit role');
        const asset = host.blob(r.handle);
        if (!asset) throw new Error('Reference handle is unavailable in this host scope');
        validateMedia(asset);
        return { ...r, ...asset, bytes: Uint8Array.from(asset.bytes), sha256: hash(asset.bytes) };
      });
      const sceneIndex = resolved.findIndex(r => ['edit-target', 'scene-layout'].includes(r.role));
      if (sceneIndex > 0 || resolved.filter(r => ['edit-target', 'scene-layout'].includes(r.role)).length > 1)
        throw new Error('Use one primary scene/edit reference as image 1');
      if (resolved.length && !provider.capabilities.edit) throw new Error('This provider cannot use references');
      const now = new Date().toISOString();
      const job: CreationJob = { schema: AIGC_PROTOCOL, id: randomUUID(), requestId, signature, kind,
        prompt: args.prompt, parameters: structuredClone(args.parameters ?? {}) as Record<string, unknown>,
        references: resolved.map(({ bytes, ...r }) => ({ ...r, bytes: bytes.length })),
        status: 'accepted', createdAt: now, updatedAt: now, provider: provider.capabilities.provider,
        artifacts: [], goalCompleted: false,
        ...(typeof args.task_id === 'string' ? { taskId: args.task_id } : ctx.taskId ? { taskId: ctx.taskId } : {}) };
      resolved.forEach((r, i) => this.saveAsset(job.id + '-input-' + i, r));
      job.effectivePrompt = withReferenceRoles(job.prompt, job.references);
      this.save(job); // Intent exists before the possibly billable provider call.
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const active: Active = { controller, done: Promise.resolve() };
      this.active.set(job.id, active);
      active.done = Promise.resolve().then(async () => {
        if (this.host !== host || this.epoch !== epoch) return;
        if (signal.aborted) {
          if (!terminal(job.status)) { job.status = 'cancelled'; job.remoteOutcome = 'unknown'; job.reason = 'Cancelled before provider dispatch'; this.save(job); }
          return;
        }
        job.status = 'running'; this.save(job);
        try {
          const result = await provider.generate({ kind, prompt: job.effectivePrompt!, references: resolved, parameters: job.parameters,
            requestId: job.id, onAccepted: id => {
              if (this.host === host && this.epoch === epoch && !terminal(job.status) && /^[\w-]{1,160}$/.test(id)) {
                job.providerRequestId = id; this.save(job);
              }
            } }, signal);
          signal.throwIfAborted();
          if (this.host !== host || this.epoch !== epoch || terminal(job.status)) return;
          if (result.artifacts.length < 1 || result.artifacts.length > 8) throw new Error('Provider did not return a bounded set of artifacts');
          job.artifacts = result.artifacts.map((asset, i) => {
            validateMedia(asset, kind);
            const id = job.id + '-output-' + i; this.saveAsset(id, asset);
            return { id, mime: asset.mime, bytes: asset.bytes.length, sha256: hash(asset.bytes), name: id + extension(asset.mime) };
          });
          job.status = 'succeeded';
          Object.assign(job, { remoteOutcome: 'confirmed', model: result.model,
            providerRequestId: result.providerRequestId ?? job.providerRequestId, usage: result.usage,
            evidence: { ...result.evidence, containerSignature: 'checked', contentApproved: false,
              playbackVerified: false, singingVoiceVerified: false } });
        } catch (error) {
          if (this.host !== host || this.epoch !== epoch || terminal(job.status)) return;
          job.status = signal.aborted ? 'cancelled' : 'unknown'; job.remoteOutcome = 'unknown';
          job.reason = signal.aborted ? 'Local request aborted; remote outcome may be unknown'
            : error instanceof Error ? error.message : 'Provider failed without terminal evidence';
          if (error instanceof ImageGenerationError && error.providerRequestId) job.providerRequestId = error.providerRequestId;
        }
        if (this.host !== host || this.epoch !== epoch) return;
        this.save(job);
        const out = this.outcome(job, job.status === 'succeeded');
        try {
          await host.pushEvent({ source: 'aigc', type: 'aigc.job', origin: 'external', ts: job.updatedAt,
            text: out.text, meta: { protocol: AIGC_PROTOCOL, id: job.id, terminal: terminal(job.status) }, blobs: out.blobs }, { trigger: 'flush' });
        } catch { host.log.warn('AIGC result archived; completion event delivery failed'); }
      }).catch(() => host.log.warn('AIGC archive failed; reconcile the original request before retrying'))
        .finally(() => this.active.delete(job.id));
      return this.outcome(job);
    } catch (error) { return { text: error instanceof Error ? error.message : 'Creation operation failed', failed: true }; }
  }
}
