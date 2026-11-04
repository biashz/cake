import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MENTION_RE = /(^|\s)@([A-Za-z0-9._/-]+)/g;

export interface ExpandedInput {
  text: string;
  files: string[];
  missing: string[];
}

function resolveInside(cwd: string, relative: string): string | undefined {
  const resolved = path.resolve(cwd, relative);
  const rel = path.relative(cwd, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/**
 * Expand `@path` mentions into file blocks appended to the prompt. Missing or
 * out-of-workspace paths are reported and left untouched.
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
  if (mentions.length === 0) return { text: input, files: [], missing: [] };

  const blocks: string[] = [];
  const files: string[] = [];
  const missing: string[] = [];
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
      const content = await readFile(abs, 'utf8');
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

  if (blocks.length === 0) return { text: input, files, missing };
  return { text: `${input}\n\n${blocks.join('\n\n')}`, files, missing };
}
