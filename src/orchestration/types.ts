import type { ModelMessage } from 'ai';
import type { TokenUsage } from '../core/events.js';
import type { ModelSpec } from '../providers/types.js';

export type AgentType = 'explore' | 'plan' | 'general';

/** A request to run a child agent with an isolated context window. */
export interface SubAgentSpec {
  type: AgentType;
  prompt: string;
  /** Override the parent model, e.g. a cheaper model for exploration. */
  model?: ModelSpec;
  /** Upper bound on model↔tool steps inside the child run. */
  maxSteps?: number;
}

export interface SubAgentOutcome {
  type: AgentType;
  text: string;
  usage: TokenUsage;
  costUsd: number;
  messages: ModelMessage[];
}
