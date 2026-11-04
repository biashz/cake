import { execa } from 'execa';
import { z } from 'zod';
import { truncate } from './fs-utils.js';
import type { CakeTool, PermissionClass } from './types.js';

const SUBCOMMANDS = [
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'add',
  'commit',
  'branch',
  'checkout',
  'switch',
  'restore',
  'rm',
  'mv',
] as const;

const READ_SUBCOMMANDS = new Set<string>([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
]);

const schema = z.object({
  subcommand: z.enum(SUBCOMMANDS).describe('Git subcommand to run'),
  args: z
    .array(z.string())
    .optional()
    .describe('Additional argv passed verbatim (no shell interpolation)'),
  message: z.string().optional().describe('Commit message; required for commit'),
});

type Args = z.infer<typeof schema>;

function argvFor(args: Args): string[] {
  const argv = [args.subcommand, ...(args.args ?? [])];
  if (args.subcommand === 'commit' && args.message) argv.push('-m', args.message);
  return argv;
}

export const gitTool: CakeTool<Args, string> = {
  name: 'git',
  description:
    'Run a git subcommand in the workspace root. Arguments are passed as an argv array (never through a shell). Read-only subcommands run freely; mutating ones need approval.',
  permission: 'read',
  permissionFor: (args): PermissionClass =>
    READ_SUBCOMMANDS.has(args.subcommand) ? 'read' : 'write',
  inputSchema: schema,
  summarize: (args) => {
    const argv = argvFor(args);
    return argv.join(' ');
  },
  matchTarget: (args) => argvFor(args).join(' '),
  async execute(args, ctx) {
    if (args.subcommand === 'commit' && !args.message && !(args.args ?? []).includes('-m')) {
      throw new Error('git commit requires a message');
    }

    const result = await execa('git', argvFor(args), {
      cwd: ctx.cwd,
      reject: false,
      all: true,
      timeout: 60_000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = truncate((result.all ?? '').trimEnd());
    const status = result.timedOut
      ? 'timed out after 60000ms'
      : `exit code: ${result.exitCode ?? `signal ${result.signal ?? 'unknown'}`}`;
    return `git ${args.subcommand}\n${status}\n${output || '(no output)'}`;
  },
};
