import type { AttachmentCaps } from '../../src/desktop/api.js';

/** One picture the composer carries toward the next turn. */
export interface Attachment {
  /** The inline image the wire sends; nothing else survives the round trip. */
  dataUrl: string;
  /** `image/png · 240 KB` — the two facts a person checks before sending. */
  label: string;
}

/** A size in the units a file list uses, not a base64 length. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function attachmentLabel(file: File): string {
  const type = file.type || 'image';
  return `${type} · ${sizeLabel(file.size)}`;
}

/**
 * The formats cake sends, restated here because the browser must not import the
 * kernel's module. A test holds the two lists together.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Why this file cannot ride along, or undefined when it can. */
function refusal(file: File, caps: AttachmentCaps, room: number): string | undefined {
  const name = file.name || 'a pasted image';
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return `${name || 'That image'} is ${file.type || 'not a file type'} — cake sends PNG, JPEG, GIF or WebP`;
  }
  if (file.size > caps.maxBytes)
    return `${name} is ${sizeLabel(file.size)} — over the ${sizeLabel(caps.maxBytes)} limit`;
  if (room <= 0) return `${caps.perTurn} images per turn — remove one to add another`;
  return undefined;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Split a dropped or picked list into what can be attached and what must be
 * explained. `staged` is what already waits, so both the cap and the duplicate
 * check belong to the turn rather than to this one drop.
 */
export async function pickImages(
  files: readonly File[],
  caps: AttachmentCaps,
  staged: readonly Attachment[],
): Promise<{ accepted: Attachment[]; rejected: string[] }> {
  const accepted: Attachment[] = [];
  const rejected: string[] = [];
  const seen = new Set(staged.map((item) => item.dataUrl));
  let left = caps.perTurn - staged.length;
  for (const file of files) {
    const reason = refusal(file, caps, left);
    if (reason) {
      rejected.push(reason);
      continue;
    }
    const name = file.name || 'a pasted image';
    try {
      const dataUrl = await readDataUrl(file);
      // One picture, one slot: the same bytes twice would be billed twice.
      if (seen.has(dataUrl)) {
        rejected.push(`${name} is already attached`);
        continue;
      }
      seen.add(dataUrl);
      accepted.push({ dataUrl, label: attachmentLabel(file) });
      left -= 1;
    } catch (err) {
      rejected.push(`${name} could not be read: ${(err as Error).message}`);
    }
  }
  return { accepted, rejected };
}

/**
 * The data URL inside a stored content part, so a replayed transcript can show
 * the picture it was sent with. Undefined for anything that is not an image.
 */
export function imageOfPart(part: unknown): string | undefined {
  const record = part as { type?: unknown; mediaType?: unknown; data?: unknown };
  if (record?.type !== 'file' || typeof record.mediaType !== 'string') return undefined;
  if (record.mediaType !== 'image' && !record.mediaType.startsWith('image/')) return undefined;
  const data = record.data;
  const base64 =
    typeof data === 'string'
      ? data
      : typeof (data as { data?: unknown })?.data === 'string'
        ? (data as { data: string }).data
        : undefined;
  return base64 === undefined ? undefined : `data:${record.mediaType};base64,${base64}`;
}

/** Every picture in a stored message's content parts. */
export function imagesOfContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map(imageOfPart)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}
