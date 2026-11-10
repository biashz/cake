import { parseArgs } from 'node:util';
import { render } from 'ink';
import { App } from './cli/App.js';
import { runHeadless } from './cli/headless.js';
import { helpText } from './cli/help.js';
import { revertTurn } from './cli/revert.js';
import { loadConfig } from './config/config.js';
import { CheckpointStore } from './core/checkpoints.js';
import { buildSystemPrompt, loadProjectInstructions } from './core/context.js';
import { formatDoctor, runDoctor } from './diagnostics/doctor.js';
import { openMcpServers } from './mcp/client.js';
import { MODE_NAMES, parsePermissionMode } from './permissions/modes.js';
import { loadSettings } from './permissions/settings.js';
import { createDefaultRegistry } from './providers/registry.js';
import type { ModelSpec } from './providers/types.js';
import { resolveEmbedder } from './runtime/toolset.js';
import { prepareSeaAssets } from './sea.js';
import { defaultSessionFile, type SessionMeta, SessionStore } from './session/store.js';
import type { PermissionMode } from './tools/types.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  await prepareSeaAssets();
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
      revert: { type: 'string' },
      doctor: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(helpText());
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

  // One undo archive per workspace, shared by the run and by --revert. Creating
  // it touches nothing: the folder appears with the first captured file.
  const checkpoints = CheckpointStore.forWorkspace(cwd);

  if (values.revert !== undefined) {
    // What each archive was asked for lives in the session database, so the
    // list can name the job behind a number instead of only the files.
    const sessions = SessionStore.open(defaultSessionFile(cwd));
    const text = await revertTurn(checkpoints, values.revert, sessions.checkpointAsks(cwd));
    sessions.close();
    process.stdout.write(`${text}\n`);
    return;
  }

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
        cwd,
        registry,
        model,
        system,
        store,
        session,
        history,
        prompt,
        mode,
        rules: settings.permissions,
        pricing: config.pricing,
        checkpoints,
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
      cwd={cwd}
      model={model}
      permissionMode={mode}
      rules={settings.permissions}
      system={system}
      store={store}
      session={session}
      initialMessages={history}
      pricing={config.pricing}
      checkpoints={checkpoints}
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
  const mode = parsePermissionMode(value);
  if (!mode) fail(`Invalid --permission-mode "${value}". Use one of: ${MODE_NAMES}`);
  return mode;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
});
