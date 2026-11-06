import type { z } from 'zod';
import type { DiffResult } from '../core/diff.js';
import type { TokenUsage } from '../core/events.js';
import type { ModelSpec } from '../providers/types.js';

/** Permission class a tool falls into; drives approval policy. */
export type PermissionClass = 'read' | 'write' | 'shell';

/** How aggressively tool calls are auto-approved. */
export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'yolo';

/** What a call would change, so approval is a decision rather than a guess. */
export interface PermissionPreview {
  /** Workspace-relative file the change lands in, when it is a file change. */
  path?: string;
  diff: DiffResult;
}

export interface PermissionRequest {
  tool: string;
  permission: PermissionClass;
  /** Short target rendered in the approval prompt: a path or a command. */
  target: string;
  /** Set when the call matched a dangerous-operation pattern. */
  danger?: string;
  /** Proposed change, when the tool can describe one before running. */
  preview?: PermissionPreview;
}

export type PermissionDecision = 'allow' | 'deny';
export type AskPermission = (request: PermissionRequest) => Promise<PermissionDecision>;

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: number;
  subject: string;
  status: TaskStatus;
}

/** Which child run a nested usage report came from. */
export interface NestedUsage {
  /** The model the child actually ran, which can differ from the parent's. */
  model: ModelSpec;
  agentType: string;
}

export interface ToolContext {
  cwd: string;
  askPermission: AskPermission;
  log: (message: string) => void;
  /** Id of the model's call that is running, so nested work can report back to it. */
  callId?: string;
  /**
   * The plan list, owned by whoever starts the run and shared by every tool call
   * in it. Required because a tool that invents its own copy loses it: each call
   * gets a fresh context object, so only the caller can keep state alive.
   */
  tasks: TaskItem[];
  /** Report the whole list after a change, so a UI can show the plan live. */
  onPlan?: (tasks: TaskItem[]) => void;
  /** Report usage from nested work (subagents) so callers can bill the whole run. */
  onUsage?: (usage: TokenUsage, costUsd: number, source?: NestedUsage) => void;
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
  /**
   * Describe the change this call would make, asked only when the user has to
   * approve it. Return nothing when the tool cannot say.
   */
  preview?(args: Args, cwd: string): Promise<PermissionPreview | undefined>;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

/** Thrown when the user (or the active mode) refuses a tool call. */
export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}
