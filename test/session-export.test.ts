import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FilePart, ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportFileName,
  exportSessionMarkdown,
  renderSession,
  type SessionRender,
  sessionMarkdown,
} from '../src/session/export.js';
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
  return render(store, id).markdown;
}

function render(store: SessionStore, id = only(store).id): SessionRender {
  const meta = store.get(id);
  if (!meta) throw new Error(`no session ${id}`);
  return renderSession({ meta, messages: store.messages(id), plan: store.plan(id) });
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

    const file = exportSessionMarkdown(store, meta.id).file;
    expect(file).toBe(path.join(dir, '.cake', 'exports', exportFileName(meta)));
    expect(await readFile(file, 'utf8')).toContain('the first prompt');

    store.saveMessages(meta.id, [
      { role: 'user', content: 'the first prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'and a reply' }] },
    ]);
    expect(await readFile(exportSessionMarkdown(store, meta.id).file, 'utf8')).toContain(
      'and a reply',
    );
    expect(await readdir(path.dirname(file))).toHaveLength(1);

    store.close();
  });

  it('honours an explicit destination', async () => {
    const store = storeWith([{ role: 'user', content: 'somewhere else' }]);
    const target = path.join(dir, 'notes', 'transcript.md');

    expect(exportSessionMarkdown(store, only(store).id, target).file).toBe(target);
    expect(await readFile(target, 'utf8')).toContain('somewhere else');
    store.close();
  });

  it('refuses a session that is not there', () => {
    const store = SessionStore.inMemory();
    expect(() => exportSessionMarkdown(store, 'nope')).toThrow(/Unknown session "nope"/);
    store.close();
  });
});

describe('session export with pictures', () => {
  /** The same bytes every time: 'hello'. */
  function picture(base64 = 'aGVsbG8=', mediaType = 'image/png'): FilePart {
    return { type: 'file', mediaType, data: base64 };
  }

  function links(md: string): string[] {
    return [...md.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map((match) => match[1] ?? '');
  }

  it('links the pictures a turn was sent with', () => {
    const store = storeWith([
      { role: 'user', content: [{ type: 'text', text: 'what is in this?' }, picture()] },
    ]);

    expect(links(markdown(store))).toEqual([
      expect.stringMatching(/^assets\/image-[0-9a-f]{12}\.png$/),
    ]);
    expect(markdown(store)).toContain('what is in this?');
    store.close();
  });

  it('keeps a turn that carried only pictures', () => {
    const store = storeWith([{ role: 'user', content: [picture(), picture('Y29weQ==')] }]);

    const md = markdown(store);
    expect(md).toContain('## 1. 2 images');
    expect(links(md)).toHaveLength(2);
    store.close();
  });

  it('names a picture by its bytes, so the same one twice links one file', () => {
    const store = storeWith([
      { role: 'user', content: [{ type: 'text', text: 'look' }, picture()] },
      { role: 'assistant', content: [{ type: 'text', text: 'seen' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }, picture()] },
    ]);

    const md = markdown(store);
    expect(links(md)).toHaveLength(2);
    expect(new Set(links(md)).size).toBe(1);
    // One name, so one file: the folder cannot hold two copies of the same pixels.
    expect(render(store).assets).toHaveLength(1);
    store.close();
  });

  it('reads the bytes whether the stored part tags them or not', () => {
    const store = storeWith([
      {
        role: 'user',
        content: [
          picture(),
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: 'aGVsbG8=' },
          },
        ],
      },
    ]);

    const assets = render(store).assets;
    expect(assets).toHaveLength(1);
    expect(assets[0]?.bytes.toString('utf8')).toBe('hello');
    store.close();
  });

  it('writes the bytes beside the Markdown that links them', async () => {
    const store = storeWith([
      { role: 'user', content: [{ type: 'text', text: 'read this' }, picture()] },
    ]);
    const target = path.join(dir, 'out', 'transcript.md');

    const written = exportSessionMarkdown(store, only(store).id, target);
    const link = links(await readFile(written.file, 'utf8'))[0] ?? '';
    // The claim a reader checks: the link resolves against the Markdown's own folder.
    expect(await readFile(path.join(path.dirname(written.file), link), 'utf8')).toBe('hello');
    // The note is built from this: where the pictures went, and how many of them.
    expect(written).toMatchObject({ file: target, pictures: 1 });
    expect(written.assetFolder).toBe(path.join(dir, 'out', 'assets'));
    expect(await readdir(written.assetFolder ?? '')).toEqual([link.split('/')[1]]);
    store.close();
  });

  it('keeps the format a picture claims in the name it writes', () => {
    const store = storeWith([
      {
        role: 'user',
        content: [picture('aGVsbG8=', 'image/jpeg'), picture('aGVsbG8=', 'image/svg+xml')],
      },
    ]);

    // The same bytes, two claimed formats: a reader needs the right suffix on each.
    expect(links(markdown(store)).map((link) => path.extname(link))).toEqual(['.jpg', '.img']);
    expect(render(store).assets.map((asset) => asset.bytes.toString('utf8'))).toEqual([
      'hello',
      'hello',
    ]);
    store.close();
  });

  it('leaves what is not a picture out of both the links and the folder', async () => {
    const store = storeWith([
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'application/pdf', data: 'JVBERg==' },
          { type: 'text', text: 'a pdf is not a picture' },
        ],
      },
    ]);
    const target = path.join(dir, 'plain', 'transcript.md');

    const written = exportSessionMarkdown(store, only(store).id, target);
    expect(written).toMatchObject({ file: target, pictures: 0 });
    expect(written.assetFolder).toBeUndefined();
    expect(await readdir(path.join(dir, 'plain'))).toEqual(['transcript.md']);
    expect(markdown(store)).not.toContain('assets/');
    store.close();
  });
});
