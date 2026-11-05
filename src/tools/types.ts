import type { z } from 'zod';
import type { TokenUsage } from '../core/events.js';

/** Permission class a tool falls into; drives approval policy. */
export type PermissionClass = 'read' | 'write' | 'shell';

/** How aggressively tool calls are auto-approved. */
export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'yolo';

export interface PermissionRequest {
  tool: string;
  permission: PermissionClass;
  /** Short target rendered in the approval prompt: a path or a command. */
  target: string;
  /** Set when the call matched a dangerous-operation pattern. */
  danger?: string;
}

export type PermissionDecision = 'allow' | 'deny';
export type AskPermission = (request: PermissionRequest) => Promise<PermissionDecision>;

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: number;
  subject: string;
  status: TaskStatus;
}

export interface ToolContext {
  cwd: string;
  askPermission: AskPermission;
  log: (message: string) => void;
  /** Shared to-do list backing the task tool; survives across turns in a run. */
  tasks?: TaskItem[];
  /** Report usage from nested work (subagents) so callers can bill the whole run. */
  onUsage?: (usage: TokenUsage, costUsd: number) => void;
}

export interface CakeTool<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  permission: PermissionClass;
  /** Per-call override, e.g. git read subcommands vs mutating ones. */
  permissionFor?(args: Args): PermissionClass;
  inputSchema: z.ZodType<Args, Args>;
  /** One-line description of a concrete call, shown when asking for approval. */
  summarize(args: Args): string;
  /** Value matched by allow/deny rules and danger patterns: a path or command. */
  matchTarget(args: Args): string;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

/** Thrown when the user (or the active mode) refuses a tool call. */
export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}
