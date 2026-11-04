import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { DEFAULT_IGNORES, truncate } from './fs-utils.js';
import type { CakeTool } from './types.js';

const MAX_MATCHES = 200;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;

const schema = z.object({
  pattern: z.string().describe('JavaScript regular expression to search for'),
  path: z
    .string()
    .optional()
    .describe('Directory to search from, relative to the workspace root (default: workspace root)'),
  glob: z.string().optional().describe("Restrict files with a glob, e.g. '*.ts' or 'src/**/*.ts'"),
  case_sensitive: z.boolean().optional().describe('Match case-sensitively (default true)'),
});

type Args = z.infer<typeof schema>;

export const grepTool: CakeTool<Args, string> = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns path:line:text matches, capped at 200.',
  permission: 'read',
  inputSchema: schema,
  summarize: (args) => {
    const scope = args.glob ?? args.path ?? '.';
    return `/${args.pattern}/ in ${scope}`;
  },
  matchTarget: (args) => args.path ?? '.',
  async execute(args, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_sensitive === false ? 'i' : '');
    } catch (err) {
      throw new Error(`Invalid regular expression: ${(err as Error).message}`);
    }

    const root = path.resolve(ctx.cwd, args.path ?? '.');
    const files = await fg(args.glob ?? '**/*', {
      cwd: root,
      ignore: DEFAULT_IGNORES,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });

    const matches: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (scanned >= MAX_FILES || matches.length >= MAX_MATCHES) break;
      const abs = path.join(root, file);
      const info = await stat(abs);
      if (info.size > MAX_FILE_BYTES) continue;
      const content = await readFile(abs, 'utf8');
      if (content.includes('\u0000')) continue;
      scanned++;

      const rel = path.relative(ctx.cwd, abs).split(path.sep).join('/');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        const line = lines[i] ?? '';
        if (!regex.test(line)) continue;
        const text = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        matches.push(`${rel}:${i + 1}: ${text.trim()}`);
      }
    }

    if (matches.length === 0) {
      return `No matches for /${args.pattern}/ (${scanned} files scanned)`;
    }
    const suffix = matches.length >= MAX_MATCHES ? `\n… match limit (${MAX_MATCHES}) reached` : '';
    return truncate(`${matches.join('\n')}${suffix}`);
  },
};
