/** Bounded, cancellable media transport shared by providers. */
export async function boundedBody(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Image response too large'); }
  if (!response.body) throw new Error('Empty image response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new Error('Image response too large');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
