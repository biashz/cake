import { detectDanger } from '../permissions/danger.js';
import { EMPTY_RULES, evaluateRules, type PermissionRules } from '../permissions/rules.js';
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
 * Enforce rules, danger checks and the active mode before a tool body runs.
 * Throws `ToolDeniedError` so the model receives a failed tool result it can
 * reason about.
 */
export async function authorize(
  tool: CakeTool,
  args: unknown,
  ctx: ToolContext,
  mode: PermissionMode,
  rules: PermissionRules = EMPTY_RULES,
): Promise<void> {
  const permission = tool.permissionFor?.(args) ?? tool.permission;
  const policy = decidePermission(mode, permission);
  if (policy === 'deny') {
    throw new ToolDeniedError(
      `${tool.name} (${permission}) is disabled in ${mode} mode: ${tool.summarize(args)}`,
    );
  }

  const target = tool.matchTarget(args);

  const rule = evaluateRules(rules, tool.name, target);
  if (rule === 'deny') {
    throw new ToolDeniedError(`Denied by rule for ${tool.name}: ${tool.summarize(args)}`);
  }

  const danger = detectDanger(tool.name, target);
  if (!danger && rule === 'allow') return;
  if (!danger && policy === 'allow') return;

  const decision = await ctx.askPermission({
    tool: tool.name,
    permission,
    target: tool.summarize(args),
    ...(danger ? { danger } : {}),
  });
  if (decision !== 'allow') {
    throw new ToolDeniedError(
      `Permission denied by user for ${tool.name}: ${tool.summarize(args)}${danger ? ` (${danger})` : ''}`,
    );
  }
}
