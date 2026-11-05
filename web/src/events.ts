import type { TokenTotals } from '../../src/desktop/api.js';
import type { TaskItem } from '../../src/tools/types.js';

/** Agent events after IPC serialization (tool errors become plain objects). */
export type WireAgentEvent =
  | { type: 'start'; model: { provider: string; modelId: string } }
  | { type: 'text-delta'; delta: string }
  | {
      type: 'tool-call';
      callId: string;
      agentCallId?: string;
      toolName: string;
      input: unknown;
    }
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
      error: { name: string; message: string };
    }
  | { type: 'subagent-start'; callId: string; agentType: string; prompt: string }
  /** Snapshot of the model's plan; the latest one replaces the previous. */
  | { type: 'plan'; tasks: TaskItem[] }
  | {
      type: 'subagent-end';
      callId: string;
      agentType: string;
      prompt: string;
      text: string;
      usage: TokenTotals;
      costUsd: number;
    }
  | { type: 'finish'; text: string; usage: TokenTotals; costUsd: number }
  | { type: 'error'; error: { name: string; message: string } };
