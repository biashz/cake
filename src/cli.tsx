import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { render } from 'ink';
import { App } from './cli/App.js';
import { loadConfig } from './config/config.js';
import { runAgent } from './core/agent.js';
import {
  buildSystemPrompt,
  createHistorySummarizer,
  loadProjectInstructions,
  maybeCompress,
} from './core/context.js';
import { addUsage, formatCost } from './core/cost.js';
import type { AgentEvent, TokenUsage } from './core/events.js';
import { expandFileReferences } from './core/mentions.js';
import { formatDoctor, runDoctor } from './diagnostics/doctor.js';
import { openMcpServers } from './mcp/client.js';
import { createTrace } from './observability/trace.js';
import { createAgentTool } from './orchestration/tool.js';
import type { PermissionRules } from './permissions/rules.js';
import { loadSettings } from './permissions/settings.js';
import { createDefaultRegistry, type ProviderRegistry } from './providers/registry.js';
import type { ModelSpec } from './providers/types.js';
import { expandCodebaseMention } from './rag/codebase-mention.js';
import { createEmbedder, DEFAULT_EMBEDDING_MODEL, type Embedder } from './rag/embedder.js';
import { createRagTools } from './rag/tools.js';
import { defaultSessionFile, type SessionMeta, SessionStore } from './session/store.js';
import { buildToolSet, createDefaultTools } from './tools/registry.js';
import type { CakeTool, PermissionMode, ToolContext } from './tools/types.js';
import { VERSION } from './version.js';

const PERMISSION_MODES: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'yolo'];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p', default: false },
      provider: { type: 'string' },
      model: { type: 'string', short: 'm' },
      yes: { type: 'boolean', short: 'y', default: false },
      'permission-mode': { type: 'string' },
      resume: { type: 'string' },
      continue: { type: 'boolean', short: 'c', default: false },
      doctor: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cwd = process.cwd();
  if (values.doctor) {
    const report = await runDoctor({ cwd });
    process.stdout.write(`${formatDoctor(report)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const registry = createDefaultRegistry(config);

  const store = SessionStore.open(defaultSessionFile(cwd));
  const resumed = resolveResume(store, values.resume, values.continue);

  const providerId = values.provider ?? resumed?.provider ?? config.provider;
  if (!registry.has(providerId)) {
    fail(
      `Unknown provider "${providerId}". Available: ${registry
        .list()
        .map((p) => p.id)
        .join(', ')}`,
    );
  }
  const provider = registry.get(providerId);
  const model: ModelSpec = {
    provider: providerId,
    modelId: values.model ?? resumed?.model ?? config.model ?? provider.defaultModelId,
  };

  if (!registry.getApiKey(providerId)) {
    fail(
      [
        `No API key found for provider "${providerId}".`,
        `  • Set ${provider.apiKeyEnvVar} in your environment, or`,
        `  • add "providers.${providerId}.apiKey" to ~/.cake/config.json`,
        '  • run "cake --doctor" to inspect providers, MCP servers, and the index',
      ].join('\n'),
    );
  }

  const mode = resolvePermissionMode(values['permission-mode'], values.yes);
  const settings = await loadSettings();
  const system = buildSystemPrompt({
    cwd,
    projectInstructions: await loadProjectInstructions(cwd),
  });
  const session = resumed ?? store.create({ cwd, provider: providerId, model: model.modelId });
  if (resumed && (resumed.provider !== providerId || resumed.model !== model.modelId)) {
    store.updateModel(session.id, providerId, model.modelId);
  }
  const history = resumed ? store.messages(session.id) : [];
  const maxContext = provider.capabilities(model.modelId).maxContext;
  const embedder = resolveEmbedder(registry);
  const mcp = await openMcpServers({
    cwd,
    onWarning: (message) => process.stderr.write(`[mcp] ${message}\n`),
  });
  if (mcp.servers.length > 0) {
    process.stderr.write(`[mcp] connected ${mcp.servers.join(', ')} (${mcp.tools.length} tools)\n`);
  }

  const prompt = positionals.join(' ').trim();
  const headless = values.print || prompt.length > 0;

  if (headless) {
    if (!prompt) fail('No prompt provided. Usage: cake -p "your prompt"');
    try {
      await runHeadless({
        registry,
        model,
        system,
        store,
        session,
        history,
        prompt,
        mode,
        rules: settings.permissions,
        maxContext,
        embedder,
        mcpTools: mcp.tools,
      });
    } finally {
      await mcp.close();
    }
    return;
  }

  if (!process.stdin.isTTY) {
    await mcp.close();
    fail('Interactive mode requires a TTY. Pass a prompt, e.g.: cake "hello"');
  }

  const app = render(
    <App
      registry={registry}
      model={model}
      permissionMode={mode}
      rules={settings.permissions}
      system={system}
      store={store}
      session={session}
      initialMessages={history}
      maxContext={maxContext}
      embedder={embedder}
      mcpTools={mcp.tools}
    />,
    { exitOnCtrlC: false },
  );
  try {
    await app.waitUntilExit();
  } finally {
    await mcp.close();
  }
}

function resolveResume(
  store: SessionStore,
  resumeId: string | undefined,
  cont: boolean,
): SessionMeta | undefined {
  if (resumeId) {
    const meta = store.get(resumeId);
    if (!meta) fail(`No session "${resumeId}" in ${defaultSessionFile(process.cwd())}`);
    return meta;
  }
  return cont ? store.latest(process.cwd()) : undefined;
}

function resolvePermissionMode(value: string | undefined, yes: boolean): PermissionMode {
  if (value === undefined) return yes ? 'yolo' : 'default';
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    fail(`Invalid --permission-mode "${value}". Use one of: ${PERMISSION_MODES.join(', ')}`);
  }
  return value as PermissionMode;
}

/** Embeddings come from OpenAI; semantic tools stay off when that key is absent. */
function resolveEmbedder(registry: ProviderRegistry): Embedder | undefined {
  if (!registry.getApiKey('openai')) return undefined;
  const model = registry.resolveEmbeddingModel(DEFAULT_EMBEDDING_MODEL);
  return model ? createEmbedder(model) : undefined;
}

function withRagTools(embedder: Embedder | undefined) {
  return embedder ? [...createDefaultTools(), ...createRagTools(embedder)] : createDefaultTools();
}

interface HeadlessOptions {
  registry: ProviderRegistry;
  model: ModelSpec;
  system: string;
  store: SessionStore;
  session: SessionMeta;
  history: ModelMessage[];
  prompt: string;
  mode: PermissionMode;
  rules: PermissionRules;
  maxContext: number;
  embedder?: Embedder;
  mcpTools?: CakeTool[];
}

async function runHeadless(options: HeadlessOptions): Promise<void> {
  const {
    registry,
    model,
    system,
    store,
    session,
    history,
    prompt,
    mode,
    rules,
    maxContext,
    embedder,
    mcpTools = [],
  } = options;
  const cwd = process.cwd();
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const trace = createTrace(cwd);
  if (trace) process.stderr.write(`[trace] ${trace.file}\n`);

  const nestedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let nestedCostUsd = 0;

  const ctx: ToolContext = {
    cwd,
    askPermission: async (request) => {
      const danger = request.danger ? ` [danger: ${request.danger}]` : '';
      process.stderr.write(
        `[permission] ${request.tool} needs approval: ${request.target}${danger} (non-interactive; pass --yes to allow)\n`,
      );
      return 'deny';
    },
    log: () => {},
    onUsage: (usage, costUsd) => {
      const total = addUsage(nestedUsage, usage);
      nestedUsage.inputTokens = total.inputTokens;
      nestedUsage.outputTokens = total.outputTokens;
      nestedUsage.totalTokens = total.totalTokens;
      nestedCostUsd += costUsd;
    },
  };

  const handleEvent = (event: AgentEvent) => {
    trace?.record(event);
    switch (event.type) {
      case 'text-delta':
        process.stdout.write(event.delta);
        break;
      case 'tool-call':
        process.stderr.write(`[tool] ${event.toolName} ${brief(event.input)}\n`);
        break;
      case 'tool-error':
        process.stderr.write(`[tool-error] ${event.toolName}: ${event.error.message}\n`);
        break;
      case 'subagent-start':
        process.stderr.write(`[subagent] ${event.agentType} started: ${brief(event.prompt)}\n`);
        break;
      case 'subagent-end':
        process.stderr.write(
          `[subagent] ${event.agentType} done (${event.usage.totalTokens} tokens, ${formatCost(event.costUsd)})\n`,
        );
        break;
    }
  };

  try {
    const codebase = await expandCodebaseMention(prompt, {
      cwd,
      embedder,
      abortSignal: controller.signal,
      onProgress: (message) => process.stderr.write(`[index] ${message}\n`),
    });
    if (codebase.results > 0) {
      process.stderr.write(`[codebase] attached ${codebase.results} chunks\n`);
    }
    if (codebase.note) process.stderr.write(`[codebase] ${codebase.note}\n`);

    const expanded = await expandFileReferences(codebase.text, cwd);
    if (expanded.files.length > 0) {
      process.stderr.write(`[files] attached ${expanded.files.join(', ')}\n`);
    }
    if (expanded.missing.length > 0) {
      process.stderr.write(
        `[files] not found or outside workspace: ${expanded.missing.join(', ')}\n`,
      );
    }

    let messages: ModelMessage[] = [...history, { role: 'user', content: expanded.text }];
    try {
      const compressed = await maybeCompress(messages, {
        maxTokens: maxContext,
        summarize: createHistorySummarizer(registry, model, controller.signal),
      });
      if (compressed.compressed) {
        process.stderr.write('[context] older history compressed\n');
      }
      messages = compressed.messages;
    } catch (err) {
      process.stderr.write(`[context] compression skipped: ${(err as Error).message}\n`);
    }

    const baseTools = [...withRagTools(embedder), ...mcpTools];
    const tools = [
      ...baseTools,
      createAgentTool({
        registry,
        model,
        systemBase: system,
        tools: baseTools,
        mode,
        rules,
        abortSignal: controller.signal,
        onEvent: handleEvent,
      }),
    ];

    const result = await runAgent(
      {
        model,
        system,
        tools: buildToolSet(tools, ctx, mode, rules),
        messages,
        abortSignal: controller.signal,
        onEvent: handleEvent,
      },
      registry,
    );
    process.stdout.write('\n');
    const totalUsage = addUsage(result.usage, nestedUsage);
    const totalCost = result.costUsd + nestedCostUsd;
    process.stderr.write(
      `[tokens] in=${totalUsage.inputTokens} out=${totalUsage.outputTokens} cost=${formatCost(totalCost)}\n`,
    );
    store.setTitleIfEmpty(session.id, prompt);
    store.saveMessages(session.id, result.messages);
    store.addUsage(session.id, {
      totalTokens: totalUsage.totalTokens,
      costUsd: totalCost,
    });
    process.stderr.write(`[session] ${session.id}\n`);
  } catch (err) {
    process.stdout.write('\n');
    process.stderr.write(`[error] ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    store.close();
  }
}

function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(
    [
      'cake — a TypeScript CLI programming agent',
      '',
      'Usage:',
      '  cake                      Start interactive chat',
      '  cake "<prompt>"           Run a single prompt (headless)',
      '  cake -p "<prompt>"        Same as above (explicit print mode)',
      '',
      'Options:',
      '  -p, --print               Headless: stream the reply and exit',
      '  -y, --yes                 Auto-approve every tool call (yolo mode)',
      '      --permission-mode <m> plan | default | acceptEdits | yolo',
      '      --provider <id>       Provider: anthropic | openai',
      '  -m, --model <id>          Model id (overrides config/default)',
      '  -c, --continue            Resume the most recent session in this workspace',
      '      --resume <id>         Resume a session by id',
      '      --doctor              Diagnose Node, providers, config, settings, MCP, sessions, index',
      '  -h, --help                Show this help',
      '  -v, --version             Print version',
      '',
      'Input:',
      '  @path/to/file             Attach a file to the prompt',
      '  @codebase                 Retrieve relevant code chunks (semantic search)',
      '  /help  /clear  /model <id>  /cost  /exit    Interactive commands',
      '',
      'Project context:',
      '  AGENTS.md files from the workspace root upward are loaded into the system prompt.',
      '  Sessions persist in .cake/sessions/cake.db (node:sqlite).',
      '',
      'MCP:',
      '  ~/.cake/mcp.json and .cake/mcp.json define "mcpServers" (stdio or http).',
      '  Tools appear as mcp__<server>__<tool>; read-only server hints map to read access.',
      '',
      'Permission modes:',
      '  plan          Read-only: file reads and searches, nothing else',
      '  default       Read tools run freely; writes and shell need approval',
      '  acceptEdits   Writes run freely; shell still needs approval',
      '  yolo          Everything runs without asking',
      '',
      'Environment:',
      '  ANTHROPIC_API_KEY | OPENAI_API_KEY   API keys',
      '  CAKE_PROVIDER, CAKE_MODEL            Defaults',
      '',
      'Rules:',
      '  .cake/settings.json  { "permissions": { "allow": ["bash(npm test*)"], "deny": [...] } }',
      '  Rule syntax: tool or tool(pattern); * and ? are wildcards; deny wins over allow.',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
});
