import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { DEFAULT_IGNORES, toPosix, truncate } from './fs-utils.js';
import type { CakeTool } from './types.js';

const MAX_RESULTS = 200;

const schema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts' or '**/*.test.ts'"),
  path: z
    .string()
    .optional()
    .describe('Directory to search from, relative to the workspace root (default: workspace root)'),
});

type Args = z.infer<typeof schema>;

export const globTool: CakeTool<Args, string> = {
  name: 'glob',
  description:
    'Find files by glob pattern. Results are sorted by modification time (newest first) and capped at 200.',
  permission: 'read',
  inputSchema: schema,
  summarize: (args) => (args.path ? `${args.pattern} in ${args.path}` : args.pattern),
  async execute(args, ctx) {
    const base = args.path ?? '.';
    const entries = await fg(args.pattern, {
      cwd: path.resolve(ctx.cwd, base),
      ignore: DEFAULT_IGNORES,
      onlyFiles: true,
      dot: false,
      stats: true,
      followSymbolicLinks: false,
    });

    if (entries.length === 0) {
      return `No files matched ${args.pattern} in ${base}`;
    }

    entries.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    const shown = entries.slice(0, MAX_RESULTS).map((entry) => {
      const rel = args.path ? path.join(args.path, entry.path) : entry.path;
      return toPosix(rel);
    });
    const suffix =
      entries.length > MAX_RESULTS ? `\n… ${entries.length - MAX_RESULTS} more not shown` : '';
    return truncate(`${shown.join('\n')}${suffix}`);
  },
};
