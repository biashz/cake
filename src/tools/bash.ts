import { execa } from 'execa';
import { z } from 'zod';
import { truncate } from './fs-utils.js';
import type { CakeTool } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

const schema = z.object({
  command: z.string().describe('Shell command to run in the workspace root'),
  description: z.string().optional().describe('Short description of what the command does'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
});

type Args = z.infer<typeof schema>;

export const bashTool: CakeTool<Args, string> = {
  name: 'bash',
  description:
    'Run a shell command in the workspace root. Returns combined stdout/stderr and the exit code. Never throws on non-zero exit.',
  permission: 'shell',
  inputSchema: schema,
  summarize: (args) => (args.description ? `${args.description} (${args.command})` : args.command),
  async execute(args, ctx) {
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const result = await execa(args.command, {
      cwd: ctx.cwd,
      shell: true,
      reject: false,
      all: true,
      timeout,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: process.env.CI ?? '1' },
    });

    const output = truncate((result.all ?? '').trimEnd());
    const status = result.timedOut
      ? `timed out after ${timeout}ms`
      : `exit code: ${result.exitCode ?? `signal ${result.signal ?? 'unknown'}`}`;
    return `${status}\n${output || '(no output)'}`;
  },
};
