import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { buildContextMap } from '../src/desktop/context-map.js';

const FILE_BLOCK = '<file path="src/a.ts">line one\nline two</file>';
const CODE_BLOCK = '<codebase query="auth flow">some indexed chunks</codebase>';

function map(input: {
  systemBase: string;
  projectSections?: { path: string; text: string }[];
  messages?: ModelMessage[];
  turn?: { label: string; tokens: number; detail?: string }[];
  maxContext?: number;
}) {
  return buildContextMap({
    systemBase: input.systemBase,
    projectSections: input.projectSections ?? [],
    messages: input.messages ?? [],
    turn: input.turn,
    maxContext: input.maxContext ?? 100_000,
  });
}

describe('buildContextMap', () => {
  it('splits stored data into the layers the kernel assembles', () => {
    const payload = map({
      systemBase: 'x'.repeat(400),
      projectSections: [{ path: 'AGENTS.md', text: 'y'.repeat(200) }],
      messages: [{ role: 'user', content: 'z'.repeat(100) }],
    });

    expect(payload.layers.map((layer) => layer.id)).toEqual(['system', 'project', 'history']);
    expect(payload.layers[0]).toMatchObject({ label: 'System', tokens: 100 });
    expect(payload.layers[1]?.entries).toEqual([
      { label: 'AGENTS.md', tokens: 50, detail: 'AGENTS.md' },
    ]);
    expect(payload.used).toBe(175);
    expect(payload.free).toBe(100_000 - 175);
    expect(payload.estimated).toBe(true);
  });

  it('credits mention blocks to the retrieved layer instead of the message that carries them', () => {
    const payload = map({
      systemBase: '',
      messages: [{ role: 'user', content: `read this please ${FILE_BLOCK} thanks` }],
    });

    const retrieved = payload.layers.find((layer) => layer.id === 'retrieved');
    const history = payload.layers.find((layer) => layer.id === 'history');
    expect(retrieved?.entries).toEqual([
      { label: '@src/a.ts', tokens: Math.ceil(FILE_BLOCK.length / 4), detail: 'file' },
    ]);
    expect(retrieved?.tokens).toBe(Math.ceil(FILE_BLOCK.length / 4));
    // The injected block is counted once: history keeps only the message's own words.
    const ownWords = 'read this please  thanks'.length;
    expect(history?.tokens).toBe(Math.ceil(ownWords / 4));
  });

  it('labels codebase mentions and merges repeated mentions of the same target', () => {
    const payload = map({
      systemBase: '',
      messages: [
        { role: 'user', content: CODE_BLOCK },
        { role: 'user', content: CODE_BLOCK },
      ],
    });

    const retrieved = payload.layers.find((layer) => layer.id === 'retrieved');
    const perHit = Math.ceil(CODE_BLOCK.length / 4);
    expect(retrieved?.entries).toEqual([
      { label: '@codebase auth flow', tokens: perHit * 2, detail: 'codebase' },
    ]);
    expect(retrieved?.tokens).toBe(perHit * 2);
  });

  it('adds the live turn layer only while a run is in flight', () => {
    const withoutTurn = map({ systemBase: 'abcd', messages: [] });
    expect(withoutTurn.layers.map((layer) => layer.id)).toEqual(['system']);

    const withTurn = map({
      systemBase: 'abcd',
      messages: [],
      turn: [
        { label: 'Prompt', tokens: 10 },
        { label: '→ read', tokens: 40, detail: 'tool' },
        { label: 'Prompt', tokens: 5 },
      ],
    });
    const turn = withTurn.layers.at(-1);
    expect(turn).toMatchObject({ id: 'turn', label: 'This turn', tokens: 55 });
    expect(turn?.entries).toHaveLength(2);
    expect(withTurn.used).toBe(56);
    expect(turn?.tokens).toBe(55);
  });

  it('never reports negative headroom when the window is oversubscribed', () => {
    const payload = map({ systemBase: 'x'.repeat(4_000), maxContext: 100 });
    expect(payload.used).toBe(1000);
    expect(payload.free).toBe(0);
  });
});
