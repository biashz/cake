import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { imageDataUrl, imageMediaType, MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from './images.js';

const MENTION_RE = /(^|\s)@([A-Za-z0-9._/-]+)/g;

export interface ExpandedInput {
  text: string;
  files: string[];
  /**
   * Mentions that never reached the prompt. One list because the reader's next
   * move is the same for every reason: check the path.
   */
  missing: string[];
  /** `@diagram.png` becomes an image part, not a block of decoded mojibake. */
  images: string[];
}

function resolveInside(cwd: string, relative: string): string | undefined {
  const resolved = path.resolve(cwd, relative);
  const rel = path.relative(cwd, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/**
 * Expand `@path` mentions into the prompt. A text file becomes a block; an
 * image becomes an image part; anything unreadable is reported and left out.
 */
export async function expandFileReferences(
  input: string,
  cwd: string,
  maxBytesPerFile = 50_000,
): Promise<ExpandedInput> {
  const mentions: string[] = [];
  for (const match of input.matchAll(MENTION_RE)) {
    const value = match[2];
    if (value) mentions.push(value);
  }
  if (mentions.length === 0) return { text: input, files: [], missing: [], images: [] };

  const blocks: string[] = [];
  const files: string[] = [];
  const missing: string[] = [];
  const images: string[] = [];
  const seen = new Set<string>();

  for (const mention of mentions) {
    if (seen.has(mention)) continue;
    seen.add(mention);
    const abs = resolveInside(cwd, mention);
    if (!abs) {
      missing.push(mention);
      continue;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile()) {
        missing.push(mention);
        continue;
      }
      const mediaType = imageMediaType(mention);
      if (mediaType) {
        if (info.size > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES_PER_TURN) {
          missing.push(mention);
          continue;
        }
        images.push(imageDataUrl(await readFile(abs), mediaType));
        files.push(mention);
        continue;
      }
      const raw = await readFile(abs);
      // NUL never appears in the text cake wants in a prompt; it marks a file
      // that would otherwise reach the model as replacement characters.
      if (raw.subarray(0, 8_000).includes(0)) {
        missing.push(mention);
        continue;
      }
      const content = raw.toString('utf8');
      const clipped =
        content.length > maxBytesPerFile
          ? `${content.slice(0, maxBytesPerFile)}\n… [truncated]`
          : content;
      blocks.push(`<file path="${mention}">\n${clipped}\n</file>`);
      files.push(mention);
    } catch {
      missing.push(mention);
    }
  }

  if (blocks.length === 0) return { text: input, files, missing, images };
  return { text: `${input}\n\n${blocks.join('\n\n')}`, files, missing, images };
}
