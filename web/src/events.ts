import type { TokenTotals } from '../../src/desktop/api.js';

/** Agent events after IPC serialization (tool errors become plain objects). */
export type WireAgentEvent =
  | { type: 'start'; model: { provider: string; modelId: string } }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'tool-result'; toolName: string; input: unknown; output: unknown }
  | { type: 'tool-error'; toolName: string; error: { name: string; message: string } }
  | { type: 'subagent-start'; agentType: string; prompt: string }
  | { type: 'subagent-end'; agentType: string; usage: TokenTotals; costUsd: number }
  | { type: 'finish'; text: string; usage: TokenTotals; costUsd: number }
  | { type: 'error'; error: { name: string; message: string } };
