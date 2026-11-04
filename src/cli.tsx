import { parseArgs } from 'node:util';
import { render } from 'ink';
import { App } from './cli/App.js';
import { loadConfig } from './config/config.js';
import { runAgent } from './core/agent.js';
import { formatCost } from './core/cost.js';
import { SYSTEM_PROMPT } from './core/prompt.js';
import { createDefaultRegistry, type ProviderRegistry } from './providers/registry.js';
import type { ModelSpec } from './providers/types.js';
import { buildToolSet, createDefaultTools } from './tools/registry.js';
import type { PermissionMode, ToolContext } from './tools/types.js';

const VERSION = '0.0.0';
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

  const config = loadConfig();
  const registry = createDefaultRegistry(config);

  const providerId = values.provider ?? config.provider;
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
    modelId: values.model ?? config.model ?? provider.defaultModelId,
  };

  if (!registry.getApiKey(providerId)) {
    fail(
      [
        `No API key found for provider "${providerId}".`,
        `  • Set ${provider.apiKeyEnvVar} in your environment, or`,
        `  • add "providers.${providerId}.apiKey" to ~/.cake/config.json`,
      ].join('\n'),
    );
  }

  const mode = resolvePermissionMode(values['permission-mode'], values.yes);
  const prompt = positionals.join(' ').trim();
  const headless = values.print || prompt.length > 0;

  if (headless) {
    if (!prompt) fail('No prompt provided. Usage: cake -p "your prompt"');
    await runHeadless(registry, model, prompt, mode);
    return;
  }

  if (!process.stdin.isTTY) {
    fail('Interactive mode requires a TTY. Pass a prompt, e.g.: cake "hello"');
  }

  render(<App registry={registry} model={model} permissionMode={mode} />, { exitOnCtrlC: false });
}

function resolvePermissionMode(value: string | undefined, yes: boolean): PermissionMode {
  if (value === undefined) return yes ? 'yolo' : 'default';
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    fail(`Invalid --permission-mode "${value}". Use one of: ${PERMISSION_MODES.join(', ')}`);
  }
  return value as PermissionMode;
}

async function runHeadless(
  registry: ProviderRegistry,
  model: ModelSpec,
  prompt: string,
  mode: PermissionMode,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  const ctx: ToolContext = {
    cwd: process.cwd(),
    askPermission: async (request) => {
      process.stderr.write(
        `[permission] ${request.tool} needs approval: ${request.target} (non-interactive; pass --yes to allow)\n`,
      );
      return 'deny';
    },
    log: () => {},
  };

  try {
    const result = await runAgent(
      {
        model,
        system: SYSTEM_PROMPT,
        tools: buildToolSet(createDefaultTools(), ctx, mode),
        messages: [{ role: 'user', content: prompt }],
        abortSignal: controller.signal,
        onEvent: (event) => {
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
          }
        },
      },
      registry,
    );
    process.stdout.write('\n');
    process.stderr.write(
      `[tokens] in=${result.usage.inputTokens} out=${result.usage.outputTokens} cost=${formatCost(result.costUsd)}\n`,
    );
  } catch (err) {
    process.stdout.write('\n');
    process.stderr.write(`[error] ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
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
      '  -h, --help                Show this help',
      '  -v, --version             Print version',
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
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
});
