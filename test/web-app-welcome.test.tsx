// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCostBoard } from '../src/core/cost-board.js';
import type { CakeApi, InitPayload } from '../src/desktop/api.js';
import { App } from '../web/src/App';

afterEach(cleanup);

/**
 * The kernel answers session:list with an error when no folder is open, and Electron
 * wraps it in "Error invoking remote method". Boot used to ask anyway, so the welcome
 * screen's first words were that sentence. These tests keep the question unasked.
 */
function bridge(overrides: { workspace: InitPayload['workspace']; asked: () => void }): CakeApi {
  const initPayload: InitPayload = {
    version: '0.1.0',
    workspace: overrides.workspace,
    recents: [],
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        defaultModelId: 'claude-sonnet-4-5',
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
  };

  const noop = () => () => {};
  const api: CakeApi = {
    init: async () => initPayload,
    pickWorkspace: async () => null,
    openWorkspace: async () => initPayload,
    listSessions: async () => {
      overrides.asked();
      // Exactly what the kernel does with no folder open.
      throw new Error('No workspace is open');
    },
    newSession: async () => {
      throw new Error('No workspace is open');
    },
    openSession: async () => {
      throw new Error('No workspace is open');
    },
    renameSession: async () => [],
    deleteSession: async () => null,
    forkSession: async () => {
      throw new Error('No workspace is open');
    },
    exportSession: async () => ({ file: 'out.md', pictures: 0 }),
    checkpointTurns: async () => [],
    revertCheckpoint: async () => ({
      checkpointId: 'turn',
      applied: true,
      changes: [],
      overwrittenBy: [],
    }),
    run: async () => {
      throw new Error('No workspace is open');
    },
    abort: async () => {},
    respondPermission: async () => {},
    setModel: async () => initPayload,
    setMode: async () => initPayload,
    setPricing: async () => initPayload,
    getCost: async () => initPayload.cost,
    setRule: async () => initPayload,
    moveRule: async () => initPayload,
    reloadMcp: async () => initPayload,
    setMcpServer: async () => initPayload,
    removeMcpServer: async () => initPayload,
    setMcpEnabled: async () => initPayload,
    listFiles: async () => [],
    runDoctor: async () => ({ checks: [], ok: true }),
    setProviderKey: async () => initPayload,
    rebuildIndex: async () => 'indexed',
    openDoctorFile: async () => 'config.json',
    revealDoctorStore: async () => 'cake.db',
    contextLayers: async () => ({
      layers: [],
      maxContext: 200_000,
      used: 0,
      free: 200_000,
      estimated: true,
    }),
    onAgentEvent: noop,
    onAgentNote: noop,
    onPermissionRequest: noop,
    onMcpStatus: noop,
  };
  return api;
}

async function boot(workspace: InitPayload['workspace']) {
  const asked: string[] = [];
  window.cake = bridge({ workspace, asked: () => asked.push('session:list') });
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return asked;
}

describe('App before a folder is open', () => {
  it('reopens a recent project through the real workspace action', async () => {
    const api = bridge({ workspace: null, asked: vi.fn() });
    const init = await api.init();
    api.init = async () => ({ ...init, recents: ['/projects/cake'] });
    api.openWorkspace = vi.fn(async () => init);
    window.cake = api;
    render(<App />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cake.*\/projects\/cake/ }));
    });
    expect(api.openWorkspace).toHaveBeenCalledWith('/projects/cake');
  });

  it('only interrupts the conversation for the selected provider missing a key', async () => {
    const api = bridge({ workspace: { cwd: '/repo', sessionId: 's1' }, asked: vi.fn() });
    const init = await api.init();
    api.listSessions = async () => [];
    api.init = async () => ({ ...init, missingKeys: ['openai'] });
    window.cake = api;
    const view = render(<App />);
    await act(async () => {});
    expect(screen.queryByText(/Add an API key/)).toBeNull();
    view.unmount();
    api.init = async () => ({ ...init, missingKeys: ['anthropic', 'openai'] });
    render(<App />);
    await act(async () => {});
    expect(screen.getByText('Add an API key for Anthropic to start a conversation.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a key' })).toBeTruthy();
  });

  it('opens the welcome screen without asking for a session list', async () => {
    const asked = await boot(null);

    expect(document.querySelector('.welcome')).toBeTruthy();
    expect(asked).toEqual([]);
    // The one thing that must not be on this screen: an error about the folder you
    // have not been asked to open yet.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still reads the rail when a folder is already open', async () => {
    const asked = await boot({ cwd: '/repo', sessionId: 's1' });

    expect(asked).toEqual(['session:list']);
    // The listing failed here on purpose, so the rail says so instead of showing rows
    // that were never read; the guard only decides whether to ask.
    expect(screen.getByRole('alert').textContent).toContain('No workspace is open');
  });
});
