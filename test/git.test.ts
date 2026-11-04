import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitTool } from '../src/tools/git.js';
import type { ToolContext } from '../src/tools/types.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-git-'));
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'cake@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Cake Test'], { cwd });
  ctx = { cwd, askPermission: async () => 'allow', log: () => {} };
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('git tool', () => {
  it('classifies read and write subcommands', () => {
    const read = gitTool.permissionFor?.({ subcommand: 'status' });
    const write = gitTool.permissionFor?.({ subcommand: 'commit', message: 'x' });
    expect(read).toBe('read');
    expect(write).toBe('write');
  });

  it('runs status and reports untracked files', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'hello', 'utf8');
    const out = await gitTool.execute({ subcommand: 'status', args: ['--short'] }, ctx);
    expect(out).toContain('exit code: 0');
    expect(out).toContain('a.txt');
  });

  it('stages and commits with a message', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'hello', 'utf8');
    const add = await gitTool.execute({ subcommand: 'add', args: ['a.txt'] }, ctx);
    expect(add).toContain('exit code: 0');

    const commit = await gitTool.execute({ subcommand: 'commit', message: 'add a.txt' }, ctx);
    expect(commit).toContain('exit code: 0');

    const log = await gitTool.execute({ subcommand: 'log', args: ['--oneline'] }, ctx);
    expect(log).toContain('add a.txt');
  });

  it('requires a message for commit', async () => {
    await expect(gitTool.execute({ subcommand: 'commit' }, ctx)).rejects.toThrow(
      /requires a message/,
    );
  });

  it('returns non-zero output without throwing', async () => {
    const out = await gitTool.execute({ subcommand: 'show', args: ['does-not-exist'] }, ctx);
    expect(out).toContain('exit code: 128');
  });
});
