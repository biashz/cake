import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { lineDiff } from '../core/diff.js';
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

/** Where this call would put new_string, or the reason it cannot. */
function planEdit(content: string, args: Args, rel: string): { next: string; replaced: number } {
  if (args.old_string === args.new_string) {
    throw new Error(`old_string and new_string are identical in ${rel}`);
  }

  const first = content.indexOf(args.old_string);
  if (first === -1) {
    throw new Error(`old_string not found in ${rel}`);
  }

  if (args.replace_all) {
    const parts = content.split(args.old_string);
    return { next: parts.join(args.new_string), replaced: parts.length - 1 };
  }

  const second = content.indexOf(args.old_string, first + args.old_string.length);
  if (second !== -1) {
    throw new Error(
      `old_string appears more than once in ${rel}; add surrounding context or set replace_all`,
    );
  }
  return {
    next: content.slice(0, first) + args.new_string + content.slice(first + args.old_string.length),
    replaced: 1,
  };
}

export const editTool: CakeTool<Args, string> = {
  name: 'edit',
  description:
    'Replace an exact string in an existing file. By default old_string must occur exactly once; set replace_all to replace every occurrence.',
  permission: 'write',
  inputSchema: schema,
  summarize: (args) => args.path,
  matchTarget: (args) => args.path,
  fileTarget: (args) => args.path,
  async preview(args, cwd) {
    const abs = resolveInside(cwd, args.path);
    const rel = toPosix(path.relative(cwd, abs));
    try {
      const content = await readFile(abs, 'utf8');
      return { path: rel, diff: lineDiff(content, planEdit(content, args, rel).next) };
    } catch {
      return undefined;
    }
  },
  async execute(args, ctx) {
    const abs = resolveInside(ctx.cwd, args.path);
    const rel = toPosix(path.relative(ctx.cwd, abs));
    const content = await readFile(abs, 'utf8');
    const plan = planEdit(content, args, rel);

    await writeFile(abs, plan.next, 'utf8');
    return `Replaced ${plan.replaced} occurrence${plan.replaced === 1 ? '' : 's'} in ${rel}`;
  },
};
