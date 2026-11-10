import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { render } from 'ink';
import React from 'react';
import { App, type AppProps } from '../../src/cli/App.js';
import { CheckpointStore } from '../../src/core/checkpoints.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ModelProvider } from '../../src/providers/types.js';
import { defaultSessionFile, SessionStore } from '../../src/session/store.js';
import type { PermissionMode } from '../../src/tools/types.js';

/**
 * The interactive CLI driven the way a terminal drives it: keys arrive one at a
 * time, and the test reads back the frame ink painted. Everything else — the
 * session database, the undo archive, the tools — is the real thing in a temp
 * workspace, so a green frame means a person would have seen it too.
 */

/**
 * One key event per write: a real raw-mode terminal never hands over a whole line.
 * The screen below is not a TTY, so ink paints plain text: what a test reads is
 * what a person reads, without the colour codes in the way.
 */
function fakeKeyboard() {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const handle = stdin as unknown as Record<string, unknown>;
  handle.isTTY = true;
  handle.setRawMode = () => stdin;
  handle.setEncoding = () => stdin;
  handle.ref = () => stdin;
  handle.unref = () => stdin;
  return stdin;
}

/** A stdout that keeps every frame, because the point is what got painted. */
function fakeScreen() {
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      frames.push(String(chunk));
      done();
    },
  }) as unknown as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.isTTY = false;
  return { stdout, frames };
}

export interface CliApp {
  /** The newest frame, without the colour codes. */
  frame(): string;
  /** Every frame so far, oldest first — what a scrollback would show. */
  frames(): string[];
  /** One key, as the terminal would send it (`\r` for Enter, `\x03` for Ctrl+C). */
  press(key: string): Promise<void>;
  /** Each character of `text` as its own key event. */
  type(text: string): Promise<void>;
  /** Type a line and press Enter. */
  submit(text: string): Promise<void>;
  /** Wait for a frame containing this text, and say what was on screen if none came. */
  waitFor(text: string): Promise<void>;
  /** Wait until no frame mentions this text — for what a command must not print. */
  waitWithout(text: string): Promise<void>;
  /**
   * Wait until the app takes keys again. It drops everything typed while a turn
   * is running, so a test that types too eagerly loses its first characters —
   * exactly what a person who answers a card and keeps typing hits.
   */
  ready(): Promise<void>;
  /** Resolves when the app quits itself, which is how `/exit` is observed. */
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

const keyWait = () => new Promise((resolve) => setTimeout(resolve, 4));

/**
 * A provider that answers any ask with one line and records what it was asked.
 * The record is how a test sees the history the app actually sends, which is
 * otherwise invisible on screen.
 */
export function echoModel(asked: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    // A compressed history asks for its summary with generateText, so the model
    // that answers turns has to answer that too — otherwise the app reports
    // `compression skipped` and a test waits for a note that never comes.
    async doGenerate({ prompt }) {
      asked.push(JSON.stringify(prompt));
      return {
        content: [{ type: 'text' as const, text: 'a summary of the older turns' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      };
    },
    async doStream({ prompt }) {
      asked.push(JSON.stringify(prompt));
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'echo' },
            { type: 'text-delta', id: 'echo', delta: 'ok' },
            { type: 'text-end', id: 'echo' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
}

export function renderCliApp(props: AppProps): CliApp {
  const stdin = fakeKeyboard();
  const { stdout, frames } = fakeScreen();
  const app = render(React.createElement(App, props), {
    stdin,
    stdout,
    debug: true,
    exitOnCtrlC: false,
  });
  // ink only repaints when something changed, so the newest frame is the whole
  // screen rather than a diff, and the fake screen is not a TTY, so it is plain
  // text — the same words a person reads.
  const screens = () => frames.slice();

  async function until(want: (shots: string[]) => boolean): Promise<string[]> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const shots = screens();
      if (want(shots)) return shots;
      await keyWait();
    }
    const last = screens().at(-1) ?? '(nothing painted)';
    throw new Error(`the screen never showed what the test waited for; last frame was:\n${last}`);
  }

  return {
    frame: () => frames.at(-1) ?? '',
    frames: screens,
    async press(key) {
      stdin.write(key);
      await keyWait();
    },
    async type(text) {
      await this.ready();
      for (const char of text) {
        stdin.write(char);
        await keyWait();
      }
    },
    async submit(text) {
      await this.type(text);
      await this.press('\r');
    },
    async waitFor(text) {
      await until((shots) => shots.some((shot) => shot.includes(text)));
    },
    async waitWithout(text) {
      await until((shots) => !(shots.at(-1) ?? '').includes(text));
    },
    async ready() {
      await until((shots) => !(shots.at(-1) ?? '').includes('(working'));
    },
    async waitUntilExit() {
      await app.waitUntilExit();
    },
    unmount() {
      app.unmount();
    },
  };
}

export interface CliScenario {
  /** The workspace the app is running in. */
  dir: string;
  store: SessionStore;
  checkpoints: CheckpointStore;
  app: CliApp;
  props: AppProps;
  /** Unmounts the app; the store closes with it, so assert before calling this. */
  close(): void;
}

/**
 * Context windows per model id, so a test can ask whether a turn used the
 * budget of the model it is running or the one the session started with.
 */
export const WIDE_WINDOW = 200_000;
export const NARROW_MODEL_ID = 'claude-narrow';
export const NARROW_WINDOW = 4_000;
const MODEL_WINDOWS: Record<string, number> = {
  [NARROW_MODEL_ID]: NARROW_WINDOW,
};

/**
 * An app over a real database and a real undo archive, pointed at a model that
 * answers from a script. `answers` are the turns the provider replies with; a
 * `null` in the list means the model asked for a tool instead.
 */
export async function cliScenario(
  model?: MockLanguageModelV4,
  options: {
    mode?: PermissionMode;
    initialMessages?: AppProps['initialMessages'];
    /** Which model the session starts on; the window comes from MODEL_WINDOWS. */
    modelId?: string;
  } = {},
): Promise<CliScenario> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cake-cli-app-'));
  // A command-only test never reaches the model; if one does, it is the command
  // that asked, not the test.
  const answers =
    model ??
    new MockLanguageModelV4({
      doStream: () => {
        throw new Error('a slash command never asks the model');
      },
    });
  const provider: ModelProvider = {
    id: 'anthropic',
    label: 'mock',
    defaultModelId: 'claude-sonnet-4-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    languageModel: () => answers,
    capabilities: (modelId) => ({
      toolCalling: true,
      vision: true,
      maxContext: MODEL_WINDOWS[modelId] ?? WIDE_WINDOW,
    }),
  };
  const registry = new ProviderRegistry().register(provider, 'test-key');
  const store = SessionStore.open(defaultSessionFile(dir));
  const startedOn = options.modelId ?? 'claude-sonnet-4-5';
  const session = store.create({ cwd: dir, provider: 'anthropic', model: startedOn });
  const props: AppProps = {
    registry,
    cwd: dir,
    model: { provider: 'anthropic', modelId: startedOn },
    permissionMode: options.mode ?? 'default',
    rules: { allow: [], deny: [] },
    system: 'test system',
    store,
    session,
    initialMessages: options.initialMessages ?? [],
    pricing: {},
    checkpoints: CheckpointStore.forWorkspace(dir),
  };
  const app = renderCliApp(props);
  return {
    dir,
    store,
    checkpoints: props.checkpoints,
    app,
    props,
    close() {
      app.unmount();
    },
  };
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
