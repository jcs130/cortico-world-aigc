import type { CreationKind, MediaBytes, ArtImage } from '../contracts.ts';
const MAX_INPUT = 10 * 1024 * 1024;
/** Reject mislabeled error pages; do not save HTML/JSON as an image. */
export function imageMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Image response is not PNG, JPEG or WebP');
}
export function validateArtImage(image: ArtImage, max = MAX_INPUT): void {
  if (!image.bytes.length || image.bytes.length > max) throw new Error('Image exceeds the configured input/output byte limit');
  if (imageMime(image.bytes) !== image.mime) throw new Error('Image MIME does not match its bytes');
}
/** Container signatures only. Decodability and artistic quality require separate inspection. */
export function validateMedia(media: MediaBytes, kind?: CreationKind): void {
  const b = Buffer.from(media.bytes);
  if (!b.length || b.length > 256 * 1024 * 1024) throw new Error('Invalid media byte length');
  let mime: string;
  if (media.mime.startsWith('image/')) mime = imageMime(b);
  else if (b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') mime = 'audio/wav';
  else if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') mime = 'video/mp4';
  else if (b.length >= 3 && (b.toString('ascii', 0, 3) === 'ID3' || b[0] === 255 && (b[1]! & 224) === 224)) mime = 'audio/mpeg';
  else throw new Error('Unsupported media container; expected PNG/JPEG/WebP, WAV/MP3 or MP4');
  if (mime !== media.mime) throw new Error('Media MIME does not match its container signature');
  if (kind && !mime.startsWith(kind === 'music' ? 'audio/' : kind + '/')) throw new Error('Output media does not match requested creation kind');
}
export const extension = (mime: string) => ({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4',
}[mime] ?? '.bin');
