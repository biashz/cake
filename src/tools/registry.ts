import { tool as aiTool, type ToolSet } from 'ai';
import type { PermissionRules } from '../permissions/rules.js';
import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { gitTool } from './git.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { authorize, isToolAvailable } from './permissions.js';
import { readTool } from './read.js';
import { taskTool } from './task.js';
import type { CakeTool, PermissionMode, ToolContext } from './types.js';
import { writeTool } from './write.js';

export function createDefaultTools(): CakeTool[] {
  return [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    gitTool,
    bashTool,
    taskTool,
  ] as CakeTool[];
}

/**
 * Adapt the internal tool definitions to the AI SDK tool set, pruning tools the
 * active permission mode can never run. Approval happens inside `execute`, so a
 * denial surfaces to the model as an error tool result it can react to.
 */
export function buildToolSet(
  tools: CakeTool[],
  ctx: ToolContext,
  mode: PermissionMode,
  rules: PermissionRules = { allow: [], deny: [] },
): ToolSet {
  const set: ToolSet = {};
  for (const item of tools) {
    if (!isToolAvailable(mode, item)) continue;
    set[item.name] = aiTool({
      description: item.description,
      inputSchema: item.inputSchema,
      execute: async (args: unknown) => {
        await authorize(item, args, ctx, mode, rules);
        return item.execute(args, ctx);
      },
    });
  }
  return set;
}
