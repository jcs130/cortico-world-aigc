import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AigcWorldConfig, CreationKind, GenerationInput, GenerationPort, GenerationResult, MediaProviderConfig } from '../contracts.ts';
import { createImageGenerationPort, IMAGE_PROVIDER_DEFAULTS, boundedBody, ImageGenerationError } from './image-generation.ts';

const MEDIA_DEFAULTS: MediaProviderConfig = {
  provider: 'none', endpoint: '', model: '', apiKeyEnv: '', resultHosts: [], timeoutMs: 1_800_000, pollMs: 5000, maxReferences: 0,
};
export function aigcDefaults(): AigcWorldConfig {
  return { enabled: false, image: structuredClone(IMAGE_PROVIDER_DEFAULTS),
    video: structuredClone(MEDIA_DEFAULTS), music: structuredClone(MEDIA_DEFAULTS) };
}
const safeId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) throw new Error('Provider acceptance id missing or invalid; do not resubmit');
  return value;
};
function apiUrl(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Provider URL must be explicitly configured without credentials/query');
  return url;
}
export function createMediaPort(kind: 'video' | 'music', config: MediaProviderConfig,
  options: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): GenerationPort | null {
  if (config.provider === 'none') return null;
  const endpoint = apiUrl(config.endpoint);
  if (!config.model || !Number.isInteger(config.pollMs) || config.pollMs < 50 || config.pollMs > 60000
    || !Number.isInteger(config.maxReferences) || config.maxReferences < 0 || config.maxReferences > 14
    || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 3_600_000)
    throw new Error('Invalid media provider model/timeouts');
  if (!['gateway', kind === 'video' ? 'bailian-wan27' : 'fal-music', ...(kind === 'music' ? ['yue-gateway'] : [])].includes(config.provider))
    throw new Error('Provider does not support the requested media kind');
  const native = ['bailian-wan27', 'fal-music'].includes(config.provider);
  if (native && (config.maxReferences !== 0 || endpoint.protocol !== 'https:'))
    throw new Error('This native text-only media adapter requires HTTPS and maxReferences=0');
  const http = options.fetch ?? globalThis.fetch;
  const headers = () => {
    const env = options.env ?? process.env, key = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
    if (config.apiKeyEnv && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv) || !key || /[\r\n]/.test(key))) throw new Error('Configured media key is missing or invalid');
    if (native && !key) throw new Error('Native cloud media API requires an explicit key environment variable');
    return { 'Content-Type': 'application/json',
      ...(key ? { Authorization: (config.provider === 'fal-music' ? 'Key ' : 'Bearer ') + key } : {}) };
  };
  const json = async (url: URL | string, signal: AbortSignal, init: RequestInit = {}): Promise<any> => {
    let response: Response;
    try { response = await http(url, { ...init, signal, headers: { ...headers(), ...init.headers }, redirect: 'error' }); }
    catch { signal.throwIfAborted(); throw new Error('Media transport outcome unknown; reconcile original request before resubmitting'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('Media provider HTTP ' + response.status + '; no automatic retry'); }
    return JSON.parse(Buffer.from(await boundedBody(response, 4 * 1024 * 1024, signal)).toString('utf8'));
  };
  const download = async (raw: unknown, mime: string, signal: AbortSignal) => {
    if (typeof raw !== 'string') throw new Error('Provider output URL is missing');
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash
      || !config.resultHosts.includes(url.hostname)) throw new Error('Media result host is not explicitly configured');
    // Storage never receives inference credentials.
    const response = await http(url, { signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Media output download failed; do not regenerate'); }
    return { bytes: await boundedBody(response, 256 * 1024 * 1024, signal), mime };
  };
  return {
    capabilities: { kind, generate: true, edit: !native && config.maxReferences > 0, maxReferences: config.maxReferences, provider: config.provider },
    async generate(input, parent): Promise<GenerationResult> {
      const signal = AbortSignal.any([parent, AbortSignal.timeout(config.timeoutMs)]);
      signal.throwIfAborted();
      if (input.kind !== kind || input.references.length > config.maxReferences) throw new Error('Unsupported media kind/references');
      const p = input.parameters;
      if (config.provider === 'bailian-wan27') {
        if (!/^wan2\.7-t2v(?:-|$)/.test(config.model)) throw new Error('This adapter implements only the documented Wan2.7 text-to-video protocol');
        const duration = Number(p.durationSec ?? 5), resolution = String(p.resolution ?? '720P'), ratio = String(p.ratio ?? '16:9');
        if (!Number.isInteger(duration) || duration < 2 || duration > 15 || !['720P', '1080P'].includes(resolution)
          || !['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio)) throw new Error('Invalid Wan video parameters');
        const accepted = await json(endpoint, signal, { method: 'POST', headers: { 'X-DashScope-Async': 'enable' },
          body: JSON.stringify({ model: config.model, input: { prompt: input.prompt },
            parameters: { duration, resolution, ratio, prompt_extend: false, watermark: true } }) });
        const id = safeId(accepted.output?.task_id); input.onAccepted?.(id);
        const query = new URL('/api/v1/tasks/' + id, endpoint);
        for (;;) {
          const result = await json(query, signal);
          const state = result.output?.task_status;
          if (state === 'SUCCEEDED') return { artifacts: [await download(result.output.video_url, 'video/mp4', signal)],
            model: config.model, providerRequestId: id, usage: result.usage,
            evidence: { durationControl: 'provider-parameter', frameContentVerified: false } };
          if (!['PENDING', 'RUNNING'].includes(state)) throw new ImageGenerationError('Wan original task ended with state ' + String(state), id);
          await delay(config.pollMs, undefined, { signal });
        }
      }
      if (config.provider === 'fal-music') {
        if (input.prompt.length < 10 || input.prompt.length > 2000 || String(p.lyrics ?? '').length > 3500
          || p.instrumental !== true && (typeof p.lyrics !== 'string' || !p.lyrics.trim())) throw new Error('Music needs style prompt and explicit lyrics or instrumental=true');
        const accepted = await json(endpoint, signal, { method: 'POST', body: JSON.stringify({
          prompt: input.prompt, lyrics: p.instrumental === true ? '' : p.lyrics,
          is_instrumental: p.instrumental === true, lyrics_optimizer: false,
          audio_setting: { format: 'wav', sample_rate: 44100, bitrate: 256000 },
        }) });
        const id = safeId(accepted.request_id); input.onAccepted?.(id);
        const ownedUrl = (raw: unknown): URL => {
          if (typeof raw !== 'string') throw new Error('FAL control URL missing');
          const url = apiUrl(raw);
          if (url.origin !== endpoint.origin || !url.pathname.includes('/requests/' + id)) throw new Error('FAL control URL does not belong to original task');
          return url;
        };
        const status = ownedUrl(accepted.status_url), resultUrl = ownedUrl(accepted.response_url);
        for (;;) {
          const state = (await json(status, signal)).status;
          if (state === 'COMPLETED') {
            const result = await json(resultUrl, signal);
            return { artifacts: [await download(result.audio?.url, 'audio/wav', signal)], model: config.model,
              providerRequestId: id, evidence: { lyricsVerified: false, singerIdentityVerified: false, durationControl: 'provider-generated' } };
          }
          if (!['IN_QUEUE', 'IN_PROGRESS'].includes(state)) throw new ImageGenerationError('FAL original task ended with state ' + String(state), id);
          await delay(config.pollMs, undefined, { signal });
        }
      }
      const base = endpoint.href.replace(/\/$/, '') + '/';
      const references = input.references.map(r => ({ role: r.role, mime: r.mime, sha256: r.sha256,
        data: Buffer.from(r.bytes).toString('base64') }));
      const legacyYue = config.provider === 'yue-gateway';
      const body = legacyYue ? { ...p, title: p.title ?? 'Untitled', requestText: input.prompt,
        style: p.style ?? input.prompt, requestKey: input.requestId }
        : { schema: 'agent-aigc-gateway/v1', kind, model: config.model, request_id: input.requestId,
          prompt: input.prompt, parameters: p, references };
      if (legacyYue && (input.references.length || !Number.isInteger(p.durationSec) || Number(p.durationSec) < 30
        || Number(p.durationSec) > 120 || p.instrumental !== true && !String(p.lyrics ?? '').trim()))
        throw new Error('YuE bridge requires durationSec 30..120 and lyrics or instrumental=true; voice cloning is not implied');
      let result = await json(new URL('jobs', base), signal, { method: 'POST', body: JSON.stringify(body) });
      const id = safeId(result.job_id ?? result.jobId); input.onAccepted?.(id);
      for (;;) {
        const state = result.status ?? result.state;
        if (state === 'succeeded' || legacyYue && ['ready', 'review'].includes(state)) {
          let artifacts;
          if (Array.isArray(result.artifacts)) artifacts = await Promise.all(result.artifacts.map((a: any) => download(a.url, a.mime, signal)));
          else if (legacyYue && config.libraryDirectory && typeof result.trackId === 'string') {
            const root = realpathSync(config.libraryDirectory);
            const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
            const track = catalog.tracks?.find((t: any) => t.id === result.trackId);
            if (typeof track?.wavFile !== 'string' || isAbsolute(track.wavFile)) throw new Error('YuE result is absent from configured catalog');
            const file = realpathSync(join(root, track.wavFile)), rel = relative(root, file);
            if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('YuE catalog asset escapes configured directory');
            artifacts = [{ bytes: readFileSync(file), mime: 'audio/wav' }];
          } else throw new Error('Completed gateway job has no retrievable artifact');
          return { artifacts, model: config.model, providerRequestId: id, evidence: {
            upstreamState: state, contentApproved: false, singingVoiceVerified: false } };
        }
        if (!['accepted', 'queued', 'running', 'generating', 'validating', 'reviewing'].includes(state))
          throw new ImageGenerationError('Gateway original task ended with state ' + String(state), id);
        await delay(config.pollMs, undefined, { signal });
        result = await json(new URL('jobs/' + id, base), signal);
      }
    },
  };
}
export function createCreationPort(kind: CreationKind, cfg: AigcWorldConfig,
  options: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): GenerationPort | null {
  if (kind !== 'image') return createMediaPort(kind, cfg[kind], options);
  const port = createImageGenerationPort(cfg.image, options);
  if (!port) return null;
  return {
    capabilities: { kind, provider: cfg.image.provider, ...port.capabilities },
    async generate(input, signal) {
      const result = await port.generate({ prompt: input.prompt,
        images: input.references.map(({ bytes, mime }) => ({ bytes, mime })),
        ...(typeof input.parameters.size === 'string' ? { size: input.parameters.size } : {}),
        requestId: input.requestId, onAccepted: input.onAccepted }, signal);
      return { artifacts: [{ bytes: result.bytes, mime: result.mime }], model: result.model,
        providerRequestId: result.providerRequestId, usage: result.usage };
    },
  };
}
