import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { lineDiff } from '../core/diff.js';
import { resolveInside, toPosix } from './fs-utils.js';
import type { CakeTool } from './types.js';

const schema = z.object({
  path: z.string().describe('File path relative to the workspace root'),
  content: z.string().describe('Full file content to write'),
});

type Args = z.infer<typeof schema>;

export const writeTool: CakeTool<Args, string> = {
  name: 'write',
  description:
    'Create or overwrite a file with the given content. Parent directories are created automatically. Prefer edit for changing existing files.',
  permission: 'write',
  inputSchema: schema,
  summarize: (args) => `${args.path} (${args.content.length} chars)`,
  matchTarget: (args) => args.path,
  async preview(args, cwd) {
    const abs = resolveInside(cwd, args.path);
    const before = await readFile(abs, 'utf8').catch(() => '');
    return { path: toPosix(path.relative(cwd, abs)), diff: lineDiff(before, args.content) };
  },
  async execute(args, ctx) {
    const abs = resolveInside(ctx.cwd, args.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, args.content, 'utf8');
    const bytes = Buffer.byteLength(args.content, 'utf8');
    const lines = args.content.length === 0 ? 0 : args.content.split('\n').length;
    return `Wrote ${bytes} bytes (${lines} lines) to ${toPosix(path.relative(ctx.cwd, abs))}`;
  },
};
