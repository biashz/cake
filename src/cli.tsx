import { parseArgs } from 'node:util';
import { render } from 'ink';
import { App } from './cli/App.js';
import { loadConfig } from './config/config.js';
import { runAgent } from './core/agent.js';
import { formatCost } from './core/cost.js';
import { createDefaultRegistry, type ProviderRegistry } from './providers/registry.js';
import type { ModelSpec } from './providers/types.js';

const VERSION = '0.0.0';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p', default: false },
      provider: { type: 'string' },
      model: { type: 'string', short: 'm' },
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

  const prompt = positionals.join(' ').trim();
  const headless = values.print || prompt.length > 0;

  if (headless) {
    if (!prompt) fail('No prompt provided. Usage: cake -p "your prompt"');
    await runHeadless(registry, model, prompt);
    return;
  }

  if (!process.stdin.isTTY) {
    fail('Interactive mode requires a TTY. Pass a prompt, e.g.: cake "hello"');
  }

  render(<App registry={registry} model={model} />, { exitOnCtrlC: false });
}

async function runHeadless(
  registry: ProviderRegistry,
  model: ModelSpec,
  prompt: string,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const result = await runAgent(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        abortSignal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'text-delta') process.stdout.write(event.delta);
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
      '      --provider <id>       Provider: anthropic | openai',
      '  -m, --model <id>          Model id (overrides config/default)',
      '  -h, --help                Show this help',
      '  -v, --version             Print version',
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
