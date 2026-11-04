import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorize, decidePermission, isToolAvailable } from '../src/tools/permissions.js';
import { buildToolSet, createDefaultTools } from '../src/tools/registry.js';
import {
  type CakeTool,
  type PermissionClass,
  type PermissionMode,
  type PermissionRequest,
  type ToolContext,
  ToolDeniedError,
} from '../src/tools/types.js';

const readTool = createDefaultTools().find((tool) => tool.name === 'read') as CakeTool;
const writeTool = createDefaultTools().find((tool) => tool.name === 'write') as CakeTool;
const bashTool = createDefaultTools().find((tool) => tool.name === 'bash') as CakeTool;
const gitTool = createDefaultTools().find((tool) => tool.name === 'git') as CakeTool;

function ctxWith(decision: 'allow' | 'deny', seen: PermissionRequest[] = []): ToolContext {
  return {
    cwd: path.sep,
    askPermission: async (request) => {
      seen.push(request);
      return decision;
    },
    log: () => {},
  };
}

describe('decidePermission', () => {
  const cases: Array<[PermissionMode, PermissionClass, string]> = [
    ['plan', 'read', 'allow'],
    ['plan', 'write', 'deny'],
    ['plan', 'shell', 'deny'],
    ['default', 'read', 'allow'],
    ['default', 'write', 'ask'],
    ['default', 'shell', 'ask'],
    ['acceptEdits', 'read', 'allow'],
    ['acceptEdits', 'write', 'allow'],
    ['acceptEdits', 'shell', 'ask'],
    ['yolo', 'read', 'allow'],
    ['yolo', 'write', 'allow'],
    ['yolo', 'shell', 'allow'],
  ];

  it.each(cases)('%s + %s -> %s', (mode, permission, expected) => {
    expect(decidePermission(mode, permission)).toBe(expected);
  });
});

describe('isToolAvailable', () => {
  it('prunes every non-read tool in plan mode', () => {
    expect(isToolAvailable('plan', readTool)).toBe(true);
    expect(isToolAvailable('plan', writeTool)).toBe(false);
    expect(isToolAvailable('plan', bashTool)).toBe(false);
  });
});

describe('authorize', () => {
  it('does not ask for a read tool in default mode', async () => {
    const seen: PermissionRequest[] = [];
    await authorize(readTool, { path: 'a.ts' }, ctxWith('allow', seen), 'default');
    expect(seen).toHaveLength(0);
  });

  it('asks before a write and proceeds on allow', async () => {
    const seen: PermissionRequest[] = [];
    await authorize(writeTool, { path: 'a.ts', content: '' }, ctxWith('allow', seen), 'default');
    expect(seen).toEqual([{ tool: 'write', permission: 'write', target: 'a.ts (0 chars)' }]);
  });

  it('throws ToolDeniedError when the user denies', async () => {
    await expect(
      authorize(writeTool, { path: 'a.ts', content: '' }, ctxWith('deny'), 'default'),
    ).rejects.toBeInstanceOf(ToolDeniedError);
  });

  it('denies without asking in plan mode', async () => {
    const seen: PermissionRequest[] = [];
    await expect(
      authorize(writeTool, { path: 'a.ts', content: '' }, ctxWith('allow', seen), 'plan'),
    ).rejects.toBeInstanceOf(ToolDeniedError);
    expect(seen).toHaveLength(0);
  });

  it('keeps git readable but denies mutations in plan mode', async () => {
    await authorize(gitTool, { subcommand: 'status' }, ctxWith('allow'), 'plan');
    await expect(
      authorize(gitTool, { subcommand: 'commit', message: 'x' }, ctxWith('allow'), 'plan'),
    ).rejects.toBeInstanceOf(ToolDeniedError);
  });

  it('auto-approves writes in acceptEdits mode', async () => {
    const seen: PermissionRequest[] = [];
    await authorize(writeTool, { path: 'a.ts', content: '' }, ctxWith('deny', seen), 'acceptEdits');
    expect(seen).toHaveLength(0);
  });
});

describe('buildToolSet', () => {
  it('exposes only read tools in plan mode', () => {
    const set = buildToolSet(createDefaultTools(), ctxWith('allow'), 'plan');
    expect(Object.keys(set).sort()).toEqual(['git', 'glob', 'grep', 'read', 'task']);
  });

  it('exposes all tools in yolo mode', () => {
    const set = buildToolSet(createDefaultTools(), ctxWith('allow'), 'yolo');
    expect(Object.keys(set).sort()).toEqual([
      'bash',
      'edit',
      'git',
      'glob',
      'grep',
      'read',
      'task',
      'write',
    ]);
  });
});

describe('authorize with rules and danger', () => {
  it('lets an allow rule skip approval in default mode', async () => {
    const seen: PermissionRequest[] = [];
    await authorize(
      writeTool,
      { path: 'src/a.ts', content: '' },
      ctxWith('deny', seen),
      'default',
      {
        allow: ['write(src/**)'],
        deny: [],
      },
    );
    expect(seen).toHaveLength(0);
  });

  it('blocks a read that matches a deny rule', async () => {
    await expect(
      authorize(readTool, { path: 'secret.txt' }, ctxWith('allow'), 'default', {
        allow: [],
        deny: ['read(secret*)'],
      }),
    ).rejects.toThrow(/Denied by rule/);
  });

  it('still asks for dangerous commands in yolo mode', async () => {
    const seen: PermissionRequest[] = [];
    await authorize(bashTool, { command: 'rm -rf /' }, ctxWith('allow', seen), 'yolo');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.danger).toBe('recursive force delete (rm -rf)');
  });

  it('does not auto-allow dangerous commands via an allow rule', async () => {
    const seen: PermissionRequest[] = [];
    await expect(
      authorize(bashTool, { command: 'git push --force' }, ctxWith('deny', seen), 'yolo', {
        allow: ['bash(*)'],
        deny: [],
      }),
    ).rejects.toThrow(/force push/);
    expect(seen).toHaveLength(1);
  });
});
