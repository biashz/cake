import type { ModelSpec } from '../providers/types.js';
import type { TaskItem } from '../tools/types.js';

/** Normalized token counts for a single agent run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Events emitted by the agent kernel to drive a UI (Ink or print mode).
 * Tool events carry raw inputs/outputs; rendering decisions live in the UI.
 *
 * `callId` pairs a result with the call that produced it. Concurrent calls of
 * the same tool share a name, so name matching alone would misattribute them.
 * Child-agent calls carry both their own `callId` and the `agentCallId` of the
 * `agent` call that spawned them, which is what lets the UI build a tree.
 */
export type AgentEvent =
  | { type: 'start'; model: ModelSpec }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; callId: string; agentCallId?: string; toolName: string; input: unknown }
  | {
      type: 'tool-result';
      callId: string;
      agentCallId?: string;
      toolName: string;
      input: unknown;
      output: unknown;
    }
  | {
      type: 'tool-error';
      callId: string;
      agentCallId?: string;
      toolName: string;
      error: Error;
    }
  | { type: 'subagent-start'; callId: string; agentType: string; prompt: string }
  /** Snapshot of the model's plan after every change to the task list. */
  | { type: 'plan'; tasks: TaskItem[] }
  | {
      type: 'subagent-end';
      callId: string;
      agentType: string;
      prompt: string;
      text: string;
      usage: TokenUsage;
      costUsd: number;
    }
  | { type: 'finish'; text: string; usage: TokenUsage; costUsd: number }
  | { type: 'error'; error: Error };
