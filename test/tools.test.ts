import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashTool } from '../src/tools/bash.js';
import { editTool } from '../src/tools/edit.js';
import { globTool } from '../src/tools/glob.js';
import { grepTool } from '../src/tools/grep.js';
import { readTool } from '../src/tools/read.js';
import type { ToolContext } from '../src/tools/types.js';
import { writeTool } from '../src/tools/write.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-tools-'));
  ctx = { cwd, tasks: [], askPermission: async () => 'allow', log: () => {} };
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function fixture(rel: string, content: string): Promise<void> {
  const abs = path.join(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

describe('read', () => {
  it('returns numbered lines with a header', async () => {
    await fixture('a.txt', 'alpha\nbeta\ngamma\n');
    const out = await readTool.execute({ path: 'a.txt' }, ctx);
    expect(out).toContain('a.txt (lines 1-3 of 3)');
    expect(out).toContain('1│ alpha');
    expect(out).toContain('3│ gamma');
  });

  it('honors offset and limit', async () => {
    await fixture('a.txt', 'one\ntwo\nthree\nfour');
    const out = await readTool.execute({ path: 'a.txt', offset: 2, limit: 1 }, ctx);
    expect(out).toContain('lines 2-2 of 4');
    expect(out).toContain('2│ two');
    expect(out).not.toContain('three');
  });

  it('rejects paths outside the workspace', async () => {
    await expect(readTool.execute({ path: '../secret.txt' }, ctx)).rejects.toThrow(
      /outside the workspace/,
    );
  });
});

describe('write', () => {
  it('creates parent directories and reports size', async () => {
    const out = await writeTool.execute({ path: 'nested/dir/file.txt', content: 'hello' }, ctx);
    expect(out).toContain('Wrote 5 bytes');
    expect(await readTool.execute({ path: 'nested/dir/file.txt' }, ctx)).toContain('1│ hello');
  });

  it('counts the lines it wrote, and a trailing newline is not one of them', async () => {
    // The number is what the model reads back to decide whether the file is
    // done; counting the empty string after a final newline told it the file
    // had a line it does not have.
    expect(await writeTool.execute({ path: 'one.txt', content: 'hello\n' }, ctx)).toContain(
      '(1 line)',
    );
    expect(await writeTool.execute({ path: 'two.txt', content: 'one\ntwo\n' }, ctx)).toContain(
      '(2 lines)',
    );
    expect(await writeTool.execute({ path: 'three.txt', content: 'no newline' }, ctx)).toContain(
      '(1 line)',
    );
    expect(await writeTool.execute({ path: 'blank.txt', content: 'a\n\nb\n' }, ctx)).toContain(
      '(3 lines)',
    );
    expect(await writeTool.execute({ path: 'empty.txt', content: '' }, ctx)).toContain('(0 lines)');
  });
});

describe('edit', () => {
  it('replaces a unique string', async () => {
    await fixture('e.ts', 'const a = 1;\n');
    const out = await editTool.execute(
      { path: 'e.ts', old_string: 'a = 1', new_string: 'a = 2' },
      ctx,
    );
    expect(out).toContain('Replaced 1 occurrence');
    expect(await readTool.execute({ path: 'e.ts' }, ctx)).toContain('a = 2');
  });

  it('refuses an ambiguous match unless replace_all is set', async () => {
    await fixture('e.ts', 'x x');
    await expect(
      editTool.execute({ path: 'e.ts', old_string: 'x', new_string: 'y' }, ctx),
    ).rejects.toThrow(/more than once/);

    const out = await editTool.execute(
      { path: 'e.ts', old_string: 'x', new_string: 'y', replace_all: true },
      ctx,
    );
    expect(out).toContain('Replaced 2 occurrences');
    expect(await readTool.execute({ path: 'e.ts' }, ctx)).toContain('y y');
  });

  it('fails when old_string is missing', async () => {
    await fixture('e.ts', 'abc');
    await expect(
      editTool.execute({ path: 'e.ts', old_string: 'zzz', new_string: 'q' }, ctx),
    ).rejects.toThrow(/not found/);
  });
});

describe('glob', () => {
  it('matches files and ignores node_modules', async () => {
    await fixture('src/a.ts', '');
    await fixture('src/b.js', '');
    await fixture('node_modules/dep/c.ts', '');
    const out = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('node_modules');
  });

  it('reports when nothing matches', async () => {
    const out = await globTool.execute({ pattern: '**/*.zzz' }, ctx);
    expect(out).toContain('No files matched');
  });
});

describe('grep', () => {
  it('reports path:line:text matches', async () => {
    await fixture('src/a.ts', 'const alpha = 1;\nconst beta = 2;\n');
    const out = await grepTool.execute({ pattern: 'beta' }, ctx);
    expect(out).toContain('src/a.ts:2: const beta = 2;');
  });

  it('is case-sensitive by default and supports case_sensitive:false', async () => {
    await fixture('a.txt', 'Alpha\n');
    expect(await grepTool.execute({ pattern: 'alpha' }, ctx)).toContain('No matches');
    expect(await grepTool.execute({ pattern: 'alpha', case_sensitive: false }, ctx)).toContain(
      'a.txt:1: Alpha',
    );
  });

  it('respects the glob filter', async () => {
    await fixture('a.ts', 'needle\n');
    await fixture('b.md', 'needle\n');
    const out = await grepTool.execute({ pattern: 'needle', glob: '*.md' }, ctx);
    expect(out).toContain('b.md:1');
    expect(out).not.toContain('a.ts');
  });
});

describe('bash', () => {
  it('captures output and exit code', async () => {
    const out = await bashTool.execute({ command: 'node -e "console.log(42)"' }, ctx);
    expect(out).toContain('exit code: 0');
    expect(out).toContain('42');
  });

  it('does not throw on non-zero exit', async () => {
    const out = await bashTool.execute({ command: 'node -e "process.exit(3)"' }, ctx);
    expect(out).toContain('exit code: 3');
  });
});
