import type { ModelSpec } from '../providers/types.js';

/** Normalized token counts for a single agent run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Events emitted by the agent kernel to drive a UI (Ink or print mode).
 * M0 covers the text-only streaming path; tool/orchestration events are added in
 * later milestones.
 */
export type AgentEvent =
  | { type: 'start'; model: ModelSpec }
  | { type: 'text-delta'; delta: string }
  | { type: 'finish'; text: string; usage: TokenUsage; costUsd: number }
  | { type: 'error'; error: Error };
