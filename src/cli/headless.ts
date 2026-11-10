import type { ModelMessage } from 'ai';
import type { CheckpointStore } from '../core/checkpoints.js';
import { formatCost, spendLabel, unpricedTokens } from '../core/cost.js';
import type { AgentEvent } from '../core/events.js';
import type { PricingOverrides } from '../core/pricing.js';
import { createTrace } from '../observability/trace.js';
import type { PermissionRules } from '../permissions/rules.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import type { Embedder } from '../rag/embedder.js';
import { buildToolCatalog } from '../runtime/toolset.js';
import { runTurn } from '../runtime/turn.js';
import type { SessionMeta, SessionStore } from '../session/store.js';
import type { CakeTool, PermissionMode, ToolContext } from '../tools/types.js';

export interface HeadlessOptions {
  /** The workspace this run works in: tools, archives, traces and exports hang off it. */
  cwd: string;
  registry: ProviderRegistry;
  model: ModelSpec;
  system: string;
  store: SessionStore;
  session: SessionMeta;
  history: ModelMessage[];
  prompt: string;
  mode: PermissionMode;
  rules: PermissionRules;
  pricing: PricingOverrides;
  checkpoints: CheckpointStore;
  embedder?: Embedder;
  mcpTools?: CakeTool[];
  /**
   * Where the run writes. The answer alone goes to `out`, so a script can pipe
   * it; everything else — tools, costs, the session id, failures — goes to `err`.
   */
  io?: { out(text: string): void; err(text: string): void };
}

function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * One prompt, one answer, no keyboard: the entry `cake "<prompt>"` and `-p` run.
 * Nobody is at the terminal to approve a tool, so a call that would need
 * approval is refused here rather than asked.
 */
export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const {
    cwd,
    registry,
    model,
    system,
    store,
    session,
    history,
    prompt,
    mode,
    rules,
    pricing,
    checkpoints,
    embedder,
    mcpTools = [],
  } = options;
  const io = options.io ?? {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const trace = createTrace(cwd);
  if (trace) io.err(`[trace] ${trace.file}\n`);

  const ctx: ToolContext = {
    cwd,
    tasks: [],
    askPermission: async (request) => {
      const danger = request.danger ? ` [danger: ${request.danger}]` : '';
      io.err(
        `[permission] ${request.tool} needs approval: ${request.target}${danger} (non-interactive; pass --yes to allow)\n`,
      );
      return 'deny';
    },
    log: () => {},
  };

  const handleEvent = (event: AgentEvent) => {
    trace?.record(event);
    switch (event.type) {
      case 'text-delta':
        io.out(event.delta);
        break;
      case 'tool-call':
        io.err(`[tool] ${event.toolName} ${brief(event.input)}\n`);
        break;
      case 'tool-error':
        io.err(`[tool-error] ${event.toolName}: ${event.error.message}\n`);
        break;
      case 'subagent-start':
        io.err(`[subagent] ${event.agentType} started: ${brief(event.prompt)}\n`);
        break;
      case 'subagent-end':
        io.err(
          `[subagent] ${event.agentType} done (${event.usage.totalTokens} tokens, ${formatCost(event.costUsd)})\n`,
        );
        break;
    }
  };

  try {
    const tools = buildToolCatalog(embedder, mcpTools, {
      registry,
      model,
      systemBase: system,
      mode,
      rules,
      pricing,
      abortSignal: controller.signal,
      onEvent: handleEvent,
    });

    const result = await runTurn({
      cwd,
      registry,
      model,
      system,
      mode,
      rules,
      tools,
      history,
      prompt,
      // Read as the turn starts, so a switch to a smaller model takes its own
      // budget with it instead of compacting against the old one.
      maxContext: registry.get(model.provider).capabilities(model.modelId).maxContext,
      pricing,
      checkpoints,
      embedder,
      ctx,
      // Recorded as the archive closes, so a turn that dies or is interrupted
      // still leaves its files undoable.
      onCheckpoint: (turn) =>
        store.recordCheckpoint({
          sessionId: session.id,
          checkpointId: turn.id,
          prompt,
          startedAt: turn.startedAt,
        }),
      abortSignal: controller.signal,
      onEvent: handleEvent,
      onNote: (note) => io.err(`[${note.kind}] ${note.text}\n`),
    });
    io.out('\n');
    io.err(
      `[tokens] in=${result.usage.inputTokens} out=${result.usage.outputTokens} cost=${spendLabel(
        result.costUsd,
        unpricedTokens(result.lines),
      )}\n`,
    );
    store.setTitleIfEmpty(session.id, prompt);
    store.saveMessages(session.id, result.messages);
    store.addTurnUsage(session.id, result.lines);
    io.err(`[session] ${session.id}\n`);
  } catch (err) {
    io.out('\n');
    io.err(`[error] ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    store.close();
  }
}
