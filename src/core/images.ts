import type { FilePart } from 'ai';

/**
 * What one turn may carry as an image, in one place so the CLI, the desktop
 * wire and the tests all refuse the same way.
 */

/** Anthropic takes at most a few images per request; more is a mistake, not a need. */
export const MAX_IMAGES_PER_TURN = 4;

/** Cap on one image's decoded bytes: ~3 MB of pixels per attachment. */
export const MAX_IMAGE_BYTES = 3_000_000;

/** The same cap as the wire sees it: base64 is 4 characters per 3 bytes. */
export const MAX_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** A data URL adds its `data:image/…;base64,` head to those characters. */
export const MAX_IMAGE_URL_CHARS = MAX_IMAGE_CHARS + 'data:image/png;base64,'.length;

/**
 * An image bills by area, not by bytes, and cake does not decode dimensions, so
 * the meter uses the vendor's own upper bound for one image. An estimate, and
 * labelled as one wherever it is shown.
 */
export const ESTIMATED_IMAGE_TOKENS = 1_600;

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The picture formats the vendors behind cake actually read. */
export const SUPPORTED_IMAGE_TYPES = [...new Set(Object.values(MEDIA_TYPES))];

/** Media type for a file by extension, or undefined when it is not a known image. */
export function imageMediaType(file: string): string | undefined {
  // Not node:path: core modules already reach the browser bundle (web/src/diff.ts) and a path API is not in one.
  const dot = file.lastIndexOf('.');
  return dot < 0 ? undefined : MEDIA_TYPES[file.slice(dot).toLowerCase()];
}

export function imageDataUrl(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * The part a model is sent. The SDK's `image` part is deprecated and gets
 * rewritten into this shape anyway, so cake writes it once, itself.
 */
export function imageFilePart(dataUrl: string): FilePart {
  return {
    type: 'file',
    mediaType: /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
  };
}

/** Shape check only: a data URL of an image type, inside the per-image cap. */
export function isImageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+$/.test(value)) return false;
  return imageBytes(value) <= MAX_IMAGE_BYTES;
}

/** Refuse a turn that would send more than the caps allow, before any spend. */
export function assertImageBudget(images: readonly string[]): void {
  if (images.length > MAX_IMAGES_PER_TURN) {
    throw new Error(`At most ${MAX_IMAGES_PER_TURN} images per turn (got ${images.length})`);
  }
  for (const image of images) {
    if (!isImageDataUrl(image)) {
      // The guard narrows everything it rejects away, so read the value as text.
      const shown = String(image)
        .slice(0, 24)
        .replace(/[\r\n]/g, ' ');
      throw new Error(
        `Each image has to be a base64 data:image URL of at most ${Math.round(MAX_IMAGE_BYTES / 1_000_000)} MB (got "${shown}…")`,
      );
    }
  }
}

/** Decoded size of a data URL, for a label a person can check against the file. */
export function imageBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function imageLabel(dataUrl: string): string {
  const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image';
  const kb = imageBytes(dataUrl) / 1024;
  return `${type} · ${kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`}`;
}

/**
 * The picture inside a stored content part: the type it claims and the bytes it
 * carries. The SDK leaves the data bare or tagged, so a reader of stored history
 * has to take either.
 */
export function storedImage(part: unknown): { mediaType: string; base64: string } | undefined {
  if (!isImagePart(part)) return undefined;
  const record = part as { mediaType: string; data?: unknown };
  const data = record.data;
  const base64 = typeof data === 'string' ? data : (data as { data?: unknown })?.data;
  return typeof base64 === 'string' ? { mediaType: record.mediaType, base64 } : undefined;
}

/**
 * Whether a content part is a picture. Cake sends `file` parts with an image
 * media type, so the meter and the transcript ask the media type, not the name.
 */
export function isImagePart(part: unknown): boolean {
  const record = part as { type?: unknown; mediaType?: unknown };
  if (record?.type !== 'file') return false;
  const mediaType = record.mediaType;
  return typeof mediaType === 'string' && (mediaType === 'image' || mediaType.startsWith('image/'));
}
