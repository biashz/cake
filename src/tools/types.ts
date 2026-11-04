import type { z } from 'zod';

/** Permission class a tool falls into; drives approval policy. */
export type PermissionClass = 'read' | 'write' | 'shell';

/** How aggressively tool calls are auto-approved. */
export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'yolo';

export interface PermissionRequest {
  tool: string;
  permission: PermissionClass;
  /** Short target rendered in the approval prompt: a path or a command. */
  target: string;
}

export type PermissionDecision = 'allow' | 'deny';
export type AskPermission = (request: PermissionRequest) => Promise<PermissionDecision>;

export interface ToolContext {
  cwd: string;
  askPermission: AskPermission;
  log: (message: string) => void;
}

export interface CakeTool<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  permission: PermissionClass;
  inputSchema: z.ZodType<Args, Args>;
  /** One-line description of a concrete call, shown when asking for approval. */
  summarize(args: Args): string;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

/** Thrown when the user (or the active mode) refuses a tool call. */
export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}
