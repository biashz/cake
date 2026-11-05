import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    tasks: [],
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
    expect(seen).toEqual([
      {
        tool: 'write',
        permission: 'write',
        target: 'a.ts (0 chars)',
        preview: { path: 'a.ts', diff: { lines: [], adds: 0, removes: 0, hidden: 0 } },
      },
    ]);
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

describe('approval preview', () => {
  const editTool = createDefaultTools().find((tool) => tool.name === 'edit') as CakeTool;

  function ctxIn(dir: string, decision: 'allow' | 'deny', seen: PermissionRequest[]): ToolContext {
    return {
      cwd: dir,
      tasks: [],
      askPermission: async (request) => {
        seen.push(request);
        return decision;
      },
      log: () => {},
    };
  }

  async function workspace(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'cake-perm-'));
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    return dir;
  }

  it('diffs a write against the file already on disk', async () => {
    const dir = await workspace({ 'a.ts': 'one\ntwo\n' });
    const seen: PermissionRequest[] = [];
    try {
      await authorize(
        writeTool,
        { path: 'a.ts', content: 'one\n2\n' },
        ctxIn(dir, 'allow', seen),
        'default',
      );
      expect(seen[0]?.preview).toMatchObject({ path: 'a.ts', diff: { adds: 1, removes: 1 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a new file as additions only', async () => {
    const dir = await workspace({});
    const seen: PermissionRequest[] = [];
    try {
      await authorize(
        writeTool,
        { path: 'new.ts', content: 'x\ny\n' },
        ctxIn(dir, 'allow', seen),
        'default',
      );
      expect(seen[0]?.preview).toMatchObject({ path: 'new.ts', diff: { adds: 3, removes: 0 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shows an edit inside its file, not only the replaced string', async () => {
    const pad = Array.from({ length: 5 }, (_, index) => `pad${index}`).join('\n');
    const dir = await workspace({ 'src/a.ts': `${pad}\ntarget\n${pad}\n` });
    const seen: PermissionRequest[] = [];
    try {
      await authorize(
        editTool,
        { path: 'src/a.ts', old_string: 'target', new_string: 'changed' },
        ctxIn(dir, 'allow', seen),
        'default',
      );
      const diff = seen[0]?.preview?.diff;
      expect(diff).toMatchObject({ adds: 1, removes: 1 });
      expect(seen[0]?.preview?.path).toBe('src/a.ts');
      // The whole file was compared, so unchanged lines arrive as context:
      // 5 pad lines on each side of the edit, plus the trailing empty line.
      expect(diff?.lines.filter((line) => line.type === 'context')).toHaveLength(11);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is absent for a tool that cannot describe a change', async () => {
    const seen: PermissionRequest[] = [];
    await authorize(bashTool, { command: 'echo hi' }, ctxWith('allow', seen), 'default');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.preview).toBeUndefined();
  });

  it('offers no preview when the edit cannot apply', async () => {
    const dir = await workspace({ 'a.ts': 'one\n' });
    const seen: PermissionRequest[] = [];
    try {
      await authorize(
        editTool,
        { path: 'a.ts', old_string: 'absent', new_string: 'x' },
        ctxIn(dir, 'allow', seen),
        'default',
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.preview).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never reads outside the workspace to build a preview', async () => {
    const dir = await workspace({});
    const seen: PermissionRequest[] = [];
    try {
      await authorize(
        writeTool,
        { path: '../../elsewhere.txt', content: 'x' },
        ctxIn(dir, 'allow', seen),
        'default',
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.preview).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is skipped when the call never needs approval', async () => {
    let previews = 0;
    const spy: CakeTool<{ path: string }, string> = {
      name: 'spy',
      description: 'counts how often a preview is requested',
      permission: 'write',
      inputSchema: z.object({ path: z.string() }),
      summarize: (args) => args.path,
      matchTarget: (args) => args.path,
      async preview(args) {
        previews += 1;
        return { path: args.path, diff: { lines: [], adds: 0, removes: 0, hidden: 0 } };
      },
      async execute() {
        return 'ok';
      },
    };
    const seen: PermissionRequest[] = [];

    await authorize(spy, { path: 'a.ts' }, ctxWith('allow', seen), 'acceptEdits');
    await authorize(spy, { path: 'a.ts' }, ctxWith('allow', seen), 'default', {
      allow: ['spy(a.ts)'],
      deny: [],
    });

    expect(previews).toBe(0);
  });
});
