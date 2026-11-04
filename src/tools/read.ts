import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveInside, toPosix, truncate } from './fs-utils.js';
import type { CakeTool } from './types.js';

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

const schema = z.object({
  path: z.string().describe('File path relative to the workspace root'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start reading from'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINES)
    .optional()
    .describe(`Maximum number of lines to return (default ${MAX_LINES})`),
});

type Args = z.infer<typeof schema>;

export const readTool: CakeTool<Args, string> = {
  name: 'read',
  description:
    'Read a text file from the workspace. Returns numbered lines. Use offset and limit for large files.',
  permission: 'read',
  inputSchema: schema,
  summarize: (args) => (args.offset ? `${args.path} (from line ${args.offset})` : args.path),
  async execute(args, ctx) {
    const abs = resolveInside(ctx.cwd, args.path);
    const rel = toPosix(path.relative(ctx.cwd, abs));
    const content = await readFile(abs, 'utf8');
    const all = content.split('\n');
    if (all.at(-1) === '') all.pop();

    const start = (args.offset ?? 1) - 1;
    const end = Math.min(all.length, start + (args.limit ?? MAX_LINES));
    const slice = all.slice(start, end);
    if (slice.length === 0) {
      return `${rel}: no lines in range (file has ${all.length} lines)`;
    }

    const width = String(end).length;
    const body = slice
      .map((line, i) => {
        const n = String(start + i + 1).padStart(width, ' ');
        const shown =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`
            : line;
        return `${n}│ ${shown}`;
      })
      .join('\n');

    return truncate(`${rel} (lines ${start + 1}-${end} of ${all.length})\n${body}`);
  },
};
