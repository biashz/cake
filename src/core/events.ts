import type { ModelSpec } from '../providers/types.js';

/** Normalized token counts for a single agent run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Events emitted by the agent kernel to drive a UI (Ink or print mode).
 * Tool events carry raw inputs/outputs; rendering decisions live in the UI.
 */
export type AgentEvent =
  | { type: 'start'; model: ModelSpec }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'tool-result'; toolName: string; input: unknown; output: unknown }
  | { type: 'tool-error'; toolName: string; error: Error }
  | { type: 'finish'; text: string; usage: TokenUsage; costUsd: number }
  | { type: 'error'; error: Error };
