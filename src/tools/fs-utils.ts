import path from 'node:path';

/** Directories never searched by glob/grep unless the pattern names them. */
export const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.cake/**',
];

/**
 * Resolve a user-supplied path and refuse anything outside the workspace root.
 * This is the M1 soft sandbox: tools can only touch the project they run in.
 */
export function resolveInside(cwd: string, input: string): string {
  const resolved = path.resolve(cwd, input);
  const rel = path.relative(cwd, resolved);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
  return resolved;
}

export function toPosix(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}
