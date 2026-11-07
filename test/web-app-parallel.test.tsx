// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyCostBoard } from '../src/core/cost-board.js';
import type {
  AgentEventEnvelope,
  AgentNoteEnvelope,
  CakeApi,
  ContextPayload,
  InitPayload,
  PermissionRequestEnvelope,
  RunResult,
  SessionInfo,
  SessionPayload,
} from '../src/desktop/api.js';
import { App } from '../web/src/App';

afterEach(cleanup);

/** A stored turn, in the shape the kernel writes and `entriesFromMessages` reads. */
interface Stored {
  role: 'user' | 'assistant';
  content: string;
}

interface FakeKernel {
  api: CakeApi;
  /** One call of `run`, in the order they arrived. A pending turn is not in the store yet. */
  turns: { sessionId: string; prompt: string }[];
  /** Answer a pending turn: write its exchange to the store, then close the run. */
  settle(sessionId: string, answer: string): Promise<void>;
  emit(sessionId: string, event: unknown): Promise<void>;
  note(sessionId: string | undefined, text: string): Promise<void>;
  ask(sessionId: string, id: string): Promise<void>;
  answered: { id: string; decision: string }[];
  stored: Record<string, Stored[]>;
}

const IDS = ['s1', 's2'] as const;

function fakeKernel(start: Record<string, Stored[]>): FakeKernel {
  const events = new Set<(wire: AgentEventEnvelope) => void>();
  const notes = new Set<(wire: AgentNoteEnvelope) => void>();
  const asks = new Set<(wire: PermissionRequestEnvelope) => void>();
  const stored = start;
  const turns: { sessionId: string; prompt: string }[] = [];
  const answered: { id: string; decision: string }[] = [];
  const waiters = new Map<string, (result: RunResult) => void>();

  const session = (id: string): SessionInfo => ({
    id,
    title: `Ticket ${id}`,
    cwd: '/repo',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    totalTokens: 10,
    costUsd: 0.01,
    unpricedTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  const payload = (id: string): SessionPayload => ({
    session: session(id),
    messages: stored[id] ?? [],
    plan: [],
  });

  const init = (): InitPayload => ({
    version: '0.1.0',
    workspace: { cwd: '/repo', sessionId: 's1' },
    recents: [],
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        defaultModelId: 'claude-sonnet-4-5',
        maxContext: 200_000,
        hasKey: true,
      },
    ],
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    attachments: { vision: false, perTurn: 4, maxBytes: 5_000_000 },
    mode: 'default',
    rules: { allow: [], deny: [], files: { project: null, global: null }, conflicts: [] },
    mcpStatus: {
      servers: [],
      tools: 0,
      warnings: [],
      rows: [],
      files: { global: null, project: null },
      changes: [],
    },
    missingKeys: [],
    cost: {
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      effective: null,
      source: null,
      overrides: [],
      builtin: [],
      configFile: null,
      board: emptyCostBoard(),
      rollup: null,
      workspace: null,
    },
    plan: [],
  });

  const context: ContextPayload = {
    layers: [],
    maxContext: 200_000,
    used: 0,
    free: 200_000,
    estimated: true,
  };

  const api: CakeApi = {
    init: async () => init(),
    pickWorkspace: async () => null,
    openWorkspace: async () => init(),
    listSessions: async () => IDS.map((id) => session(id)),
    newSession: async () => payload('s1'),
    openSession: async (id) => payload(id),
    renameSession: async () => IDS.map((id) => session(id)),
    deleteSession: async () => null,
    forkSession: async (id) => payload(id),
    exportSession: async () => ({ file: 'out.md', pictures: 0 }),
    run: async (sessionId, prompt) =>
      new Promise<RunResult>((resolve) => {
        turns.push({ sessionId, prompt });
        waiters.set(sessionId, resolve);
      }),
    abort: async () => {},
    respondPermission: async (id, decision) => {
      answered.push({ id, decision });
    },
    setModel: async () => init(),
    setMode: async () => init(),
    setPricing: async () => init(),
    getCost: async () => init().cost,
    setRule: async () => init(),
    moveRule: async () => init(),
    reloadMcp: async () => init(),
    setMcpServer: async () => init(),
    removeMcpServer: async () => init(),
    setMcpEnabled: async () => init(),
    listFiles: async () => [],
    runDoctor: async () => ({ checks: [], ok: true }),
    setProviderKey: async () => init(),
    rebuildIndex: async () => 'indexed',
    openDoctorFile: async () => 'config.json',
    revealDoctorStore: async () => 'cake.db',
    contextLayers: async () => context,
    onAgentEvent: (handler) => {
      events.add(handler);
      return () => events.delete(handler);
    },
    onAgentNote: (handler) => {
      notes.add(handler);
      return () => notes.delete(handler);
    },
    onPermissionRequest: (handler) => {
      asks.add(handler);
      return () => asks.delete(handler);
    },
    onMcpStatus: () => () => {},
  };

  const send = async (run: () => void) => {
    await act(async () => {
      run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return {
    api,
    turns,
    answered,
    stored,
    settle: async (sessionId, answer) => {
      const waiter = waiters.get(sessionId);
      if (!waiter) throw new Error(`no turn running in ${sessionId}`);
      waiters.delete(sessionId);
      // The kernel writes the exchange when the turn ends, never while it runs.
      const prompt = turns.find((turn) => turn.sessionId === sessionId)?.prompt ?? '';
      stored[sessionId] = [
        ...(stored[sessionId] ?? []),
        { role: 'user', content: prompt },
        { role: 'assistant', content: answer },
      ];
      await send(() => {
        for (const handler of events) {
          handler({
            sessionId,
            event: {
              type: 'finish',
              text: answer,
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              costUsd: 0.001,
            },
          });
        }
        waiter({
          sessionId,
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          costUsd: 0.001,
          text: answer,
        });
      });
    },
    emit: (sessionId, event) =>
      send(() => {
        for (const handler of events) handler({ sessionId, event });
      }),
    note: (sessionId, text) =>
      send(() => {
        for (const handler of notes) handler({ sessionId, note: { kind: 'index', text } });
      }),
    ask: (sessionId, id) =>
      send(() => {
        for (const handler of asks) {
          handler({
            sessionId,
            request: { id, tool: 'write_file', permission: 'write', target: 'src/a.ts' },
          });
        }
      }),
  };
}

/** Mount the app, wait for the bridge handshake, and return the session rows. */
async function boot(kernel: FakeKernel) {
  window.cake = kernel.api;
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    async type(prompt: string) {
      const input = screen.getByTestId('composer-input');
      fireEvent.change(input, { target: { value: prompt } });
      fireEvent.submit(input.closest('form') as HTMLFormElement);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async open(id: string) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`Ticket ${id}`) }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

/** The kernel notes currently on screen, in transcript order. */
function notes(): string[] {
  return screen.queryAllByTestId('entry-note').map((node) => node.textContent ?? '');
}

describe('App with two sessions', () => {
  it('keeps a running session its own transcript when you switch away and back', async () => {
    const kernel = fakeKernel({ s1: [{ role: 'user', content: 'old question' }], s2: [] });
    const ui = await boot(kernel);

    await ui.type('unfinished question');
    expect(kernel.turns).toEqual([{ sessionId: 's1', prompt: 'unfinished question' }]);

    await ui.open('s2');
    await ui.open('s1');

    // Nothing of this turn is in the store yet, so only the live buffer can show it.
    expect(screen.getByText('unfinished question')).toBeTruthy();
    // And the session is still the one that is running, not one to start over.
    expect(screen.getByTestId('composer-stop')).toBeTruthy();
  });

  it('reads the stored transcript of a session whose turn has finished', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('a finished question');
    await kernel.settle('s1', 'a finished answer');
    await ui.open('s2');
    await ui.open('s1');

    // Reloading from the store replaces the live buffer: one copy of each side.
    expect(screen.getAllByText('a finished question')).toHaveLength(1);
    expect(screen.getAllByText('a finished answer')).toHaveLength(1);
  });

  it('lets a second session start while the first is still waiting', async () => {
    const kernel = fakeKernel({ s1: [{ role: 'assistant', content: 'from the first' }], s2: [] });
    const ui = await boot(kernel);

    await ui.type('the first is waiting');
    await ui.open('s2');

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    await ui.type('the second starts anyway');

    expect(kernel.turns).toEqual([
      { sessionId: 's1', prompt: 'the first is waiting' },
      { sessionId: 's2', prompt: 'the second starts anyway' },
    ]);
    // The second session shows its own turn and none of the first's.
    expect(screen.getByText('the second starts anyway')).toBeTruthy();
    expect(screen.queryByText('the first is waiting')).toBeNull();
    expect(screen.queryByText('from the first')).toBeNull();
  });

  it('shows a background answer only in its own session', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question for the first');
    await ui.open('s2');
    await kernel.emit('s1', { type: 'text-delta', delta: 'the first’' });
    await kernel.emit('s1', { type: 'text-delta', delta: 's answer' });
    await kernel.settle('s1', 'the first’s answer');

    expect(screen.queryByText(/first’s answer/)).toBeNull();

    await ui.open('s1');
    expect(screen.getAllByText('the first’s answer')).toHaveLength(1);
  });

  it('holds an approval for the session that asked, not the one on screen', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    // Two turns waiting, and the card belongs to whichever session asks.
    await ui.type('the first waits');
    await ui.open('s2');
    await ui.type('the second waits');
    await ui.open('s1');

    await kernel.ask('s2', 'p7');
    expect(screen.queryByTestId('approvals')).toBeNull();

    await ui.open('s2');
    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());

    fireEvent.click(screen.getByTestId('approval-allow'));
    await waitFor(() => expect(kernel.answered).toEqual([{ id: 'p7', decision: 'allow' }]));
    expect(screen.queryByTestId('approvals')).toBeNull();
  });

  it('routes a note to the session it belongs to', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('the first waits');
    await ui.open('s2');
    await ui.type('the second waits');
    await ui.open('s1');

    // A note tagged with a session waits inside that session, not on screen.
    await kernel.note('s2', 'indexed for the second');
    expect(notes().join(' ')).not.toContain('indexed for the second');
    await ui.open('s2');
    expect(notes().join(' ')).toContain('indexed for the second');

    // A note with no session describes the workspace, so it lands where you stand.
    await kernel.note(undefined, 'index for the workspace');
    expect(notes().join(' ')).toContain('index for the workspace');
    await ui.open('s1');
    expect(notes().join(' ')).not.toContain('index for the workspace');
  });
});
