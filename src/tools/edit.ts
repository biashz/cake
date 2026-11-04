import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveInside, toPosix } from './fs-utils.js';
import type { CakeTool } from './types.js';

const schema = z.object({
  path: z.string().describe('File path relative to the workspace root'),
  old_string: z.string().describe('Exact text to replace; must match the file byte-for-byte'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match'),
});

type Args = z.infer<typeof schema>;

export const editTool: CakeTool<Args, string> = {
  name: 'edit',
  description:
    'Replace an exact string in an existing file. By default old_string must occur exactly once; set replace_all to replace every occurrence.',
  permission: 'write',
  inputSchema: schema,
  summarize: (args) => args.path,
  async execute(args, ctx) {
    const abs = resolveInside(ctx.cwd, args.path);
    const rel = toPosix(path.relative(ctx.cwd, abs));
    if (args.old_string === args.new_string) {
      throw new Error(`old_string and new_string are identical in ${rel}`);
    }

    const content = await readFile(abs, 'utf8');
    const first = content.indexOf(args.old_string);
    if (first === -1) {
      throw new Error(`old_string not found in ${rel}`);
    }

    let next: string;
    let replaced: number;
    if (args.replace_all) {
      const parts = content.split(args.old_string);
      replaced = parts.length - 1;
      next = parts.join(args.new_string);
    } else {
      const second = content.indexOf(args.old_string, first + args.old_string.length);
      if (second !== -1) {
        throw new Error(
          `old_string appears more than once in ${rel}; add surrounding context or set replace_all`,
        );
      }
      replaced = 1;
      next =
        content.slice(0, first) + args.new_string + content.slice(first + args.old_string.length);
    }

    await writeFile(abs, next, 'utf8');
    return `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${rel}`;
  },
};
