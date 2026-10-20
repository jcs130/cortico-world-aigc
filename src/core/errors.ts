/** A terminal provider receipt is distinct from a lost transport response. */
export class CreationProviderError extends Error {
  constructor(message: string, readonly providerRequestId?: string,
    readonly terminalStatus?: 'failed' | 'cancelled', readonly evidence?: Record<string, unknown>) {
    super(message); this.name = 'CreationProviderError';
  }
}
/** Compatibility name for existing image clients. */
export class ImageGenerationError extends CreationProviderError {
  constructor(message: string, providerRequestId?: string, terminalStatus?: 'failed' | 'cancelled', evidence?: Record<string, unknown>) {
    super(message, providerRequestId, terminalStatus, evidence); this.name = 'ImageGenerationError';
  }
}
