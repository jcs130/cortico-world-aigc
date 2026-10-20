/** Framework-neutral contracts. No game, Persona, credentials or default endpoints. */
export const AIGC_PROTOCOL = 'agent-aigc/v1' as const;
export const VISUAL_REFERENCE_PROTOCOL = 'agent-visual-reference/v1' as const;
export type CreationKind = 'image' | 'video' | 'music';
export type ReferenceRole = 'edit-target' | 'scene-layout' | 'identity' | 'style' | 'motion' | 'audio';
export interface MediaBytes { bytes: Uint8Array; mime: string }
export type ArtImage = MediaBytes;
export interface MediaReference {
  handle: string; role: ReferenceRole;
  entityId?: string; revision?: string; view?: string;
  /** Caller-supplied provenance, not a current fact or an instruction. */
  source?: { world?: string; captureId?: string; observedAt?: string; realm?: string };
}
export interface ResolvedReference extends MediaReference, MediaBytes { sha256: string }
export interface OutputArtifact { id: string; mime: string; bytes: number; sha256: string; name: string }
export interface GenerationInput {
  kind: CreationKind; prompt: string; references: readonly ResolvedReference[];
  parameters: Record<string, unknown>; requestId: string;
  onAccepted?(providerRequestId: string): void;
}
export interface GenerationResult {
  artifacts: Array<MediaBytes & { name?: string }>;
  model: string; providerRequestId?: string; usage?: Record<string, unknown>;
  /** Format validation is not a quality, lyrics, singer identity or content approval. */
  evidence?: Record<string, unknown>;
}
export interface GenerationPort {
  capabilities: { kind: CreationKind; generate: boolean; edit: boolean; maxReferences: number; provider: string;
    model?: string; parameterKeys?: readonly string[] };
  generate(input: GenerationInput, signal: AbortSignal): Promise<GenerationResult>;
}
export interface ImageGenerationRequest {
  prompt: string; images: readonly ArtImage[]; size?: string; requestId?: string;
  onAccepted?(providerRequestId: string): void;
}
export interface ImageGenerationResult extends ArtImage {
  model: string; providerRequestId?: string; usage?: Record<string, unknown>;
}
export interface ImageGenerationPort {
  capabilities: { generate: boolean; edit: boolean; maxReferences: number };
  generate(request: ImageGenerationRequest, signal: AbortSignal): Promise<ImageGenerationResult>;
}
export interface Flux3Configuration {
  unet: string; clip: string; vae: string; width: number; height: number; steps: 16;
  seed?: number; pollMs?: number;
}
export interface ImageProviderConfig {
  provider: 'none' | 'bailian' | 'volcengine' | 'comfyui-flux3';
  endpoint: string; model: string; apiKeyEnv: string;
  generate: boolean; edit: boolean; maxReferences: number; timeoutMs: number; resultHosts: string;
  flux3?: Flux3Configuration;
}
export interface MediaProviderConfig {
  provider: 'none' | 'gateway' | 'bailian-wan27' | 'fal-music' | 'yue-gateway';
  /** Full submit URL for native APIs; base URL for the documented gateway. */
  endpoint: string; model: string; apiKeyEnv: string;
  resultHosts: string[]; timeoutMs: number; pollMs: number;
  maxReferences: number;
  /** Only the explicit local YuE bridge may read this operator-selected catalog. */
  libraryDirectory?: string;
}
export interface CreationRequest {
  kind: CreationKind; prompt: string; request_id: string;
  references?: MediaReference[]; parameters?: Record<string, unknown>;
  task_id?: string;
}
export type JobStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface CreationJob {
  schema: typeof AIGC_PROTOCOL; id: string; requestId: string; signature: string;
  kind: CreationKind; prompt: string; effectivePrompt?: string; parameters: Record<string, unknown>; taskId?: string;
  references: Array<MediaReference & { sha256: string; mime: string; bytes: number }>;
  status: JobStatus; createdAt: string; updatedAt: string;
  provider: string; providerRequestId?: string; model?: string;
  artifacts: OutputArtifact[]; usage?: Record<string, unknown>; evidence?: Record<string, unknown>;
  reason?: string; remoteOutcome?: 'unknown' | 'confirmed';
  /** Generation is not playback, current-world evidence, content adoption or goal completion. */
  goalCompleted: false;
  legacy?: { schema: string; id: string; sourceSha256: string };
}
export type AssetInput = (MediaBytes & { fallbackText: string; name?: string }) | { handle: string; fallbackText: string };
export interface CreationOutcome { text: string; blobs?: AssetInput[]; failed?: true }
export interface CreationCallContext {
  callId?: string; round?: number; signal?: AbortSignal; taskId?: string;
}
export interface CreationEvent {
  source: string; type: string; ts: string; text: string;
  origin?: 'external'; meta?: Record<string, unknown>; blobs?: AssetInput[];
}
export interface CreationHost {
  blob(handle: string): MediaBytes | null;
  pushEvent(event: CreationEvent, options?: { trigger?: 'flush' | 'piggyback'; deliver?: boolean }): Promise<unknown>;
  log: { warn(message: string): void };
}
export interface StudioOptions {
  directory?: string;
  provider(kind: CreationKind): GenerationPort | null;
  maxConcurrent?: number;
}
export interface AigcWorldConfig {
  enabled: boolean; image: ImageProviderConfig; video: MediaProviderConfig; music: MediaProviderConfig;
}
