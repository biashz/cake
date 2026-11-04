import {
  type CakeTool,
  type PermissionClass,
  type PermissionMode,
  type ToolContext,
  ToolDeniedError,
} from './types.js';

export type Policy = 'allow' | 'ask' | 'deny';

/**
 * Static policy for a permission class in a given mode.
 * `plan` is read-only, `acceptEdits` auto-approves file writes but still asks
 * for shell commands, `yolo` approves everything.
 */
export function decidePermission(mode: PermissionMode, permission: PermissionClass): Policy {
  switch (mode) {
    case 'plan':
      return permission === 'read' ? 'allow' : 'deny';
    case 'acceptEdits':
      return permission === 'read' || permission === 'write' ? 'allow' : 'ask';
    case 'yolo':
      return 'allow';
    case 'default':
      return permission === 'read' ? 'allow' : 'ask';
  }
}

/** Whether a tool can ever run under this mode (used to prune the tool set). */
export function isToolAvailable(mode: PermissionMode, tool: CakeTool): boolean {
  return decidePermission(mode, tool.permission) !== 'deny';
}

/**
 * Enforce the active policy before a tool body runs. Throws `ToolDeniedError`
 * so the model receives a failed tool result it can reason about.
 */
export async function authorize(
  tool: CakeTool,
  args: unknown,
  ctx: ToolContext,
  mode: PermissionMode,
): Promise<void> {
  const policy = decidePermission(mode, tool.permission);
  if (policy === 'allow') return;

  const target = tool.summarize(args);

  if (policy === 'deny') {
    throw new ToolDeniedError(
      `${tool.name} (${tool.permission}) is disabled in ${mode} mode: ${target}`,
    );
  }

  const decision = await ctx.askPermission({
    tool: tool.name,
    permission: tool.permission,
    target,
  });
  if (decision !== 'allow') {
    throw new ToolDeniedError(`Permission denied by user for ${tool.name}: ${target}`);
  }
}
