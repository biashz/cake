import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportFileName, exportSessionMarkdown, sessionMarkdown } from '../src/session/export.js';
import { type SessionMeta, SessionStore } from '../src/session/store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cake-export-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function storeWith(messages: ModelMessage[], cwd = '/repo'): SessionStore {
  const store = SessionStore.inMemory();
  const meta = store.create({ cwd, provider: 'anthropic', model: 'claude-sonnet-4-5' });
  store.setTitleIfEmpty(meta.id, 'fix the parser');
  store.saveMessages(meta.id, messages);
  return store;
}

function only(store: SessionStore, cwd = '/repo'): SessionMeta {
  const [meta] = store.list(cwd);
  if (!meta) throw new Error(`no session in ${cwd}`);
  return meta;
}

function markdown(store: SessionStore, id = only(store).id): string {
  const meta = store.get(id);
  if (!meta) throw new Error(`no session ${id}`);
  return sessionMarkdown({ meta, messages: store.messages(id), plan: store.plan(id) });
}

describe('sessionMarkdown', () => {
  it('writes prompts, replies, calls and results in order', () => {
    const store = storeWith([
      { role: 'user', content: 'fix the parser' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'src/a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read',
            output: { type: 'text', value: 'function a() {}' },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
      { role: 'user', content: 'now add a test' },
    ]);

    const md = markdown(store);
    expect(md).toContain('# fix the parser');
    expect(md).toContain('`anthropic/claude-sonnet-4-5`');
    expect(md).toContain('## 1. fix the parser');
    expect(md).toContain('Reading it now.');
    expect(md).toContain('**call `read`**');
    expect(md).toContain('"path": "src/a.ts"');
    expect(md).toContain('**result `read`**');
    expect(md).toContain('function a() {}');
    expect(md).toContain('Fixed.');
    expect(md).toContain('## 2. now add a test');
    expect(md.indexOf('Fixed.')).toBeLessThan(md.indexOf('## 2.'));
    store.close();
  });

  it('shows what a tool returned, not the envelope that carried it', () => {
    const store = storeWith([
      { role: 'user', content: 'run it' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'bash',
            output: { type: 'json', value: { exitCode: 0, stdout: 'all good' } },
          },
        ],
      },
    ]);

    const md = markdown(store);
    expect(md).toContain('"stdout": "all good"');
    expect(md).not.toContain('"type": "json"');
    expect(md).not.toContain('tool-result');
    store.close();
  });

  it('lists the plan as checkboxes the reader can tick off', () => {
    const store = storeWith([{ role: 'user', content: 'do the thing' }]);
    store.savePlan(only(store).id, [
      { id: 1, subject: 'read the tokenizer', status: 'completed' },
      { id: 2, subject: 'patch the split', status: 'in_progress' },
      { id: 3, subject: 'run the suite', status: 'pending' },
    ]);

    expect(markdown(store)).toContain(
      ['- [x] read the tokenizer', '- [~] patch the split', '- [ ] run the suite'].join('\n'),
    );
    store.close();
  });

  it('says which session a fork came from, and says nothing about an original', () => {
    const store = storeWith([{ role: 'user', content: 'branch off' }]);
    const parent = only(store);
    const child = store.fork(parent.id);

    expect(markdown(store, child.id)).toContain(`forked from \`${parent.id.slice(0, 8)}\``);
    expect(markdown(store, parent.id)).not.toContain('forked from');
    store.close();
  });

  it('keeps a transcript that already contains code fences intact', () => {
    const nested = '```js\nconst a = 1;\n```';
    const store = storeWith([
      { role: 'user', content: 'show me' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'bash',
            output: { type: 'text', value: nested },
          },
        ],
      },
    ]);

    // The outer fence has to outgrow the three backticks inside the payload.
    expect(markdown(store)).toContain(['````', nested, '````'].join('\n'));
    store.close();
  });

  it('exports a session that never ran as a titled file with no turns', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'openai', model: 'gpt' });

    const md = sessionMarkdown({ meta, messages: [], plan: [] });
    expect(md.startsWith('# Untitled session\n')).toBe(true);
    expect(md).not.toContain('## 1.');
    expect(md).not.toContain('Plan');
    store.close();
  });

  it('numbers the turns it prints, not the rows it skipped', () => {
    const store = storeWith([
      { role: 'user', content: 'first ask' },
      { role: 'user', content: [{ type: 'text', text: '   ' }] },
      { role: 'user', content: 'second ask' },
    ]);

    const md = markdown(store);
    expect(md).toContain('## 1. first ask');
    expect(md).toContain('## 2. second ask');
    expect(md).not.toContain('## 3.');
    store.close();
  });
});

describe('exportFileName', () => {
  it('names the file after the workspace folder and the session id', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({
      cwd: path.join('/repo', 'my.app'),
      provider: 'openai',
      model: 'gpt',
    });

    expect(exportFileName(meta)).toBe(`my.app-${meta.id.slice(0, 8)}.md`);
    store.close();
  });

  it('cannot be steered out of the export folder by a strange workspace name', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo/../..', provider: 'openai', model: 'gpt' });

    const name = exportFileName(meta);
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.md$/);
    expect(name).not.toContain('..');
    expect(name.endsWith(`${meta.id.slice(0, 8)}.md`)).toBe(true);
    store.close();
  });
});

describe('exportSessionMarkdown', () => {
  it('writes under the workspace and replaces its own file', async () => {
    const store = SessionStore.open(path.join(dir, 'sessions', 'cake.db'));
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.saveMessages(meta.id, [{ role: 'user', content: 'the first prompt' }]);

    const file = exportSessionMarkdown(store, meta.id);
    expect(file).toBe(path.join(dir, '.cake', 'exports', exportFileName(meta)));
    expect(await readFile(file, 'utf8')).toContain('the first prompt');

    store.saveMessages(meta.id, [
      { role: 'user', content: 'the first prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'and a reply' }] },
    ]);
    expect(await readFile(exportSessionMarkdown(store, meta.id), 'utf8')).toContain('and a reply');
    expect(await readdir(path.dirname(file))).toHaveLength(1);

    store.close();
  });

  it('honours an explicit destination', async () => {
    const store = storeWith([{ role: 'user', content: 'somewhere else' }]);
    const target = path.join(dir, 'notes', 'transcript.md');

    expect(exportSessionMarkdown(store, only(store).id, target)).toBe(target);
    expect(await readFile(target, 'utf8')).toContain('somewhere else');
    store.close();
  });

  it('refuses a session that is not there', () => {
    const store = SessionStore.inMemory();
    expect(() => exportSessionMarkdown(store, 'nope')).toThrow(/Unknown session "nope"/);
    store.close();
  });
});
