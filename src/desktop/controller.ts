import { stat } from 'node:fs/promises';
import fg from 'fast-glob';
import { loadConfig } from '../config/config.js';
import { buildSystemPrompt, loadProjectInstructions } from '../core/context.js';
import type { AgentEvent } from '../core/events.js';
import { runDoctor as diagnose } from '../diagnostics/doctor.js';
import { type McpBundle, openMcpServers } from '../mcp/client.js';
import type { PermissionRules } from '../permissions/rules.js';
import { loadSettings } from '../permissions/settings.js';
import { createDefaultRegistry, type ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import type { Embedder } from '../rag/embedder.js';
import { buildToolCatalog, resolveEmbedder } from '../runtime/toolset.js';
import { runTurn } from '../runtime/turn.js';
import { defaultSessionFile, type SessionMeta, SessionStore } from '../session/store.js';
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ToolContext,
} from '../tools/types.js';
import { VERSION } from '../version.js';
import type {
  DoctorReportPayload,
  InitPayload,
  ModelHandle,
  PermissionModeName,
  ProviderSummary,
} from './api.js';
import type { DesktopBackend } from './ipc.js';
import { toWireEvent } from './ipc.js';
import { loadDesktopState, saveDesktopState } from './state.js';

const IGNORED_GLOBS = ['.git/**', 'node_modules/**', '.cake/**', 'dist/**', 'release/**'];
const FILE_RESULT_LIMIT = 50;

export interface ControllerDeps {
  /** `userData/state.json` in production; a temp file in tests. */
  stateFile: string;
  /** Sends a main → renderer event. */
  send(channel: string, payload: unknown): void;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

interface ActiveWorkspace {
  cwd: string;
  store: SessionStore;
  system: string;
  rules: PermissionRules;
  mcp: McpBundle;
  embedder: Embedder | undefined;
  model: ModelSpec;
  mode: PermissionMode;
  session: SessionMeta;
}

/**
 * Owns everything scoped to one open workspace: session store, MCP connections,
 * provider registry, and the currently running turn. Electron IPC only delegates
 * here, so all agent behavior stays identical to the CLI.
 */
export class WorkspaceController implements DesktopBackend {
  private readonly registry: ProviderRegistry;
  private readonly config: ReturnType<typeof loadConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string | undefined;
  private readonly stateFile: string;
  private readonly send: (channel: string, payload: unknown) => void;

  private active: ActiveWorkspace | undefined;
  private fallbackRules: PermissionRules = { allow: [], deny: [] };
  private busy = false;
  private currentAbort: AbortController | null = null;
  private readonly approvals = new Map<string, (decision: PermissionDecision) => void>();
  private approvalSeq = 0;

  constructor(deps: ControllerDeps) {
    this.stateFile = deps.stateFile;
    this.send = deps.send;
    this.env = deps.env ?? (process.env as Record<string, string | undefined>);
    this.homeDir = deps.homeDir;
    this.config = loadConfig({ env: this.env, homeDir: deps.homeDir });
    this.registry = createDefaultRegistry(this.config, this.env);
  }

  /** Reopen the last workspace when it still exists, then report the full state. */
  async init(): Promise<InitPayload> {
    this.fallbackRules = (await loadSettings({ homeDir: this.homeDir })).permissions;
    if (!this.active) {
      const state = await loadDesktopState(this.stateFile);
      if (state.lastWorkspace) {
        try {
          const info = await stat(state.lastWorkspace);
          if (!info.isDirectory()) throw new Error('not a directory');
          await this.openWorkspace(state.lastWorkspace);
        } catch {
          await saveDesktopState(this.stateFile, {});
        }
      }
    }
    return this.snapshot();
  }

  async openWorkspace(cwd: string): Promise<InitPayload> {
    if (this.busy) throw new Error('Cannot switch workspaces while a turn is running');
    const previousMode = this.active?.mode;
    await this.closeActive();

    const settings = await loadSettings({ cwd, homeDir: this.homeDir });
    const system = buildSystemPrompt({
      cwd,
      projectInstructions: await loadProjectInstructions(cwd),
    });
    const mcp = await openMcpServers({ cwd });
    const store = SessionStore.open(defaultSessionFile(cwd));
    try {
      const initial =
        store.latest(cwd) ??
        store.create({
          cwd,
          provider: this.defaultProviderId(),
          model: this.defaultModelId(),
        });
      const model = this.resolveSessionModel(initial);
      let session = initial;
      if (model.provider !== initial.provider || model.modelId !== initial.model) {
        store.updateModel(initial.id, model.provider, model.modelId);
        session = store.get(initial.id) ?? initial;
      }
      this.active = {
        cwd,
        store,
        system,
        rules: settings.permissions,
        mcp,
        embedder: resolveEmbedder(this.registry),
        model,
        mode: previousMode ?? 'default',
        session,
      };
    } catch (err) {
      await mcp.close();
      store.close();
      throw err;
    }

    await saveDesktopState(this.stateFile, { lastWorkspace: cwd });
    this.sendMcpStatus();
    return this.snapshot();
  }

  listSessions(): SessionMeta[] {
    const active = this.requireActive();
    return active.store.list(active.cwd);
  }

  newSession(): { session: SessionMeta; messages: [] } {
    const active = this.requireActive();
    const session = active.store.create({
      cwd: active.cwd,
      provider: active.model.provider,
      model: active.model.modelId,
    });
    active.session = session;
    return { session, messages: [] };
  }

  openSession(id: string): {
    session: SessionMeta;
    messages: ReturnType<SessionStore['messages']>;
  } {
    const active = this.requireActive();
    const found = active.store.get(id);
    if (!found) throw new Error(`Unknown session "${id}"`);
    this.activateSession(found);
    return { session: active.session, messages: active.store.messages(id) };
  }

  renameSession(id: string, title: string): SessionMeta[] {
    const active = this.requireActive();
    if (!active.store.get(id)) throw new Error(`Unknown session "${id}"`);
    active.store.rename(id, title);
    if (active.session.id === id) active.session = active.store.get(id) ?? active.session;
    return active.store.list(active.cwd);
  }

  deleteSession(
    id: string,
  ): { session: SessionMeta; messages: ReturnType<SessionStore['messages']> } | null {
    const active = this.requireActive();
    const found = active.store.get(id);
    if (!found) throw new Error(`Unknown session "${id}"`);
    active.store.delete(id);
    if (active.session.id !== id) return null;

    const next =
      active.store.latest(active.cwd) ??
      active.store.create({
        cwd: active.cwd,
        provider: active.model.provider,
        model: active.model.modelId,
      });
    this.activateSession(next);
    return { session: active.session, messages: active.store.messages(active.session.id) };
  }

  async run(sessionId: string, prompt: string) {
    const active = this.requireActive();
    if (this.busy) throw new Error('A turn is already running');
    if (active.session.id !== sessionId) throw new Error(`Unknown session "${sessionId}"`);

    this.busy = true;
    const controller = new AbortController();
    this.currentAbort = controller;
    const emit = (event: AgentEvent) => this.send('agent:event', toWireEvent(event));

    try {
      const tools = buildToolCatalog(active.embedder, active.mcp.tools, {
        registry: this.registry,
        model: active.model,
        systemBase: active.system,
        mode: active.mode,
        rules: active.rules,
        abortSignal: controller.signal,
        onEvent: emit,
      });
      const provider = this.registry.get(active.model.provider);
      const result = await runTurn({
        cwd: active.cwd,
        registry: this.registry,
        model: active.model,
        system: active.system,
        mode: active.mode,
        rules: active.rules,
        tools,
        history: active.store.messages(sessionId),
        prompt,
        maxContext: provider.capabilities(active.model.modelId).maxContext,
        embedder: active.embedder,
        ctx: this.toolContext(active),
        abortSignal: controller.signal,
        onEvent: emit,
        onNote: (note) => this.send('agent:note', note),
      });

      active.store.setTitleIfEmpty(sessionId, prompt);
      active.store.saveMessages(sessionId, result.messages);
      active.store.addUsage(sessionId, {
        totalTokens: result.usage.totalTokens,
        costUsd: result.costUsd,
      });
      active.session = active.store.get(sessionId) ?? active.session;
      return {
        sessionId,
        usage: result.usage,
        costUsd: result.costUsd,
        text: result.text,
      };
    } finally {
      this.busy = false;
      this.currentAbort = null;
      this.denyAllApprovals();
    }
  }

  abort(): void {
    this.currentAbort?.abort();
    this.denyAllApprovals();
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    const resolve = this.approvals.get(id);
    if (!resolve) throw new Error(`Unknown permission request "${id}"`);
    this.approvals.delete(id);
    resolve(decision);
  }

  setModel(model: ModelHandle): Promise<InitPayload> {
    const active = this.requireActive();
    const providerId = model.provider.trim();
    const modelId = model.modelId.trim();
    if (!this.registry.has(providerId)) {
      throw new Error(`Unknown provider "${providerId}"`);
    }
    if (!modelId) throw new Error('Model id cannot be empty');

    const spec: ModelSpec = { provider: providerId, modelId };
    active.model = spec;
    active.store.updateModel(active.session.id, providerId, modelId);
    active.session = active.store.get(active.session.id) ?? {
      ...active.session,
      provider: providerId,
      model: modelId,
    };
    return Promise.resolve(this.snapshot());
  }

  setMode(mode: PermissionModeName): Promise<InitPayload> {
    this.requireActive().mode = mode;
    return Promise.resolve(this.snapshot());
  }

  async reloadMcp(): Promise<InitPayload> {
    const active = this.requireActive();
    if (this.busy) throw new Error('Cannot reload MCP while a turn is running');
    await active.mcp.close();
    active.mcp = await openMcpServers({ cwd: active.cwd });
    this.sendMcpStatus();
    return this.snapshot();
  }

  async listFiles(query: string): Promise<string[]> {
    const active = this.requireActive();
    const files = await fg('**/*', {
      cwd: active.cwd,
      onlyFiles: true,
      dot: false,
      ignore: IGNORED_GLOBS,
      suppressErrors: true,
      followSymbolicLinks: false,
    });
    const needle = query.trim().toLowerCase();
    const matches = needle ? files.filter((file) => file.toLowerCase().includes(needle)) : files;
    return matches.slice(0, FILE_RESULT_LIMIT);
  }

  runDoctor(): Promise<DoctorReportPayload> {
    return diagnose({
      cwd: this.active?.cwd ?? process.cwd(),
      homeDir: this.homeDir,
      env: this.env,
    });
  }

  async dispose(): Promise<void> {
    await this.closeActive();
  }

  private snapshot(): InitPayload {
    const active = this.active;
    const providerId = active?.model.provider ?? this.defaultProviderId();
    const provider = this.registry.get(providerId);
    const fallbackModelId =
      providerId === this.config.provider && this.config.model
        ? this.config.model
        : provider.defaultModelId;
    const providers = this.providerSummaries();
    return {
      version: VERSION,
      workspace: active ? { cwd: active.cwd, sessionId: active.session.id } : null,
      providers,
      model: active?.model ?? { provider: providerId, modelId: fallbackModelId },
      mode: active?.mode ?? 'default',
      rules: active?.rules ?? this.fallbackRules,
      mcpStatus: this.mcpStatus(),
      missingKeys: providers.filter((item) => !item.hasKey).map((item) => item.id),
    };
  }

  private providerSummaries(): ProviderSummary[] {
    return this.registry.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      defaultModelId: provider.defaultModelId,
      maxContext: provider.capabilities(provider.defaultModelId).maxContext,
      hasKey: Boolean(this.registry.getApiKey(provider.id)),
    }));
  }

  private mcpStatus() {
    const active = this.active;
    if (!active) return { servers: [], tools: 0, warnings: [] };
    return {
      servers: active.mcp.servers,
      tools: active.mcp.tools.length,
      warnings: active.mcp.warnings,
    };
  }

  private sendMcpStatus(): void {
    this.send('mcp:status', this.mcpStatus());
  }

  private toolContext(active: ActiveWorkspace): ToolContext {
    return {
      cwd: active.cwd,
      askPermission: (request) => this.askPermission(request),
      log: () => {},
    };
  }

  private askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.currentAbort?.signal.aborted) return Promise.resolve('deny');
    const id = `p${++this.approvalSeq}`;
    return new Promise<PermissionDecision>((resolve) => {
      this.approvals.set(id, resolve);
      this.send('permission:request', { id, ...request });
    });
  }

  private denyAllApprovals(): void {
    for (const resolve of this.approvals.values()) resolve('deny');
    this.approvals.clear();
  }

  /** Point the active workspace at a stored session and sync its provider/model. */
  private activateSession(session: SessionMeta): void {
    const active = this.requireActive();
    const model = this.resolveSessionModel(session);
    if (model.provider !== session.provider || model.modelId !== session.model) {
      active.store.updateModel(session.id, model.provider, model.modelId);
    }
    active.session = active.store.get(session.id) ?? session;
    active.model = model;
  }

  private resolveSessionModel(session: SessionMeta): ModelSpec {
    if (this.registry.has(session.provider)) {
      return { provider: session.provider, modelId: session.model };
    }
    return { provider: this.defaultProviderId(), modelId: this.defaultModelId() };
  }

  private defaultProviderId(): string {
    if (this.registry.has(this.config.provider) && this.registry.getApiKey(this.config.provider)) {
      return this.config.provider;
    }
    const withKey = this.registry.list().find((provider) => this.registry.getApiKey(provider.id));
    return withKey?.id ?? this.registry.list()[0]?.id ?? this.config.provider;
  }

  private defaultModelId(): string {
    const providerId = this.defaultProviderId();
    const provider = this.registry.get(providerId);
    return providerId === this.config.provider && this.config.model
      ? this.config.model
      : provider.defaultModelId;
  }

  private requireActive(): ActiveWorkspace {
    if (!this.active) throw new Error('No workspace is open');
    return this.active;
  }

  private async closeActive(): Promise<void> {
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.denyAllApprovals();
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    await active.mcp.close();
    active.store.close();
  }
}
