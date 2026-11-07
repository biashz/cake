import { stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { configPaths, loadConfig } from '../config/config.js';
import { setPricingEntry, setProviderApiKey } from '../config/write.js';
import {
  buildSystemPrompt,
  estimateTextTokens,
  loadProjectSections,
  type ProjectSection,
} from '../core/context.js';
import { buildCostBoard } from '../core/cost-board.js';
import type { AgentEvent } from '../core/events.js';
import { ESTIMATED_IMAGE_TOKENS, MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from '../core/images.js';
import {
  BUILTIN_PRICING,
  type Pricing,
  type PricingOverrides,
  resolvePricing,
} from '../core/pricing.js';
import { runDoctor as diagnose } from '../diagnostics/doctor.js';
import { doctorStorePath, ensureDoctorFile } from '../diagnostics/fixes.js';
import { type McpBundle, type McpServerStatus, openMcpServers } from '../mcp/client.js';
import { mcpConfigPaths } from '../mcp/config.js';
import {
  removeMcpServer as dropServer,
  type McpTarget,
  setMcpEnabled as switchServer,
  setMcpServer as writeServer,
} from '../mcp/write.js';
import {
  globalSettingsPath,
  loadSettingsLayers,
  mergeSettings,
  type RuleScope,
  type SettingsLayer,
  settingsPaths,
} from '../permissions/settings.js';
import type { RuleList, RuleTarget } from '../permissions/write.js';
import {
  addRule as appendRule,
  removeRule as dropRule,
  moveRule as shiftRule,
} from '../permissions/write.js';
import { createDefaultRegistry, type ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import type { Embedder } from '../rag/embedder.js';
import { CodeIndexStore, defaultIndexFile } from '../rag/index-store.js';
import { indexCodebase } from '../rag/indexer.js';
import { buildToolCatalog, resolveEmbedder } from '../runtime/toolset.js';
import { runTurn } from '../runtime/turn.js';
import { type ExportResult, exportSessionMarkdown } from '../session/export.js';
import { defaultSessionFile, type SessionMeta, SessionStore } from '../session/store.js';
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  TaskItem,
  ToolContext,
} from '../tools/types.js';
import { VERSION } from '../version.js';
import type {
  ContextEntryPayload,
  ContextPayload,
  CostPayload,
  DoctorFileTargetName,
  DoctorReportPayload,
  DoctorStoreTargetName,
  InitPayload,
  McpDraft,
  McpStatus,
  ModelHandle,
  PermissionModeName,
  PricingRow,
  ProviderSummary,
  RuleScopeName,
} from './api.js';
import { buildContextMap } from './context-map.js';
import type { DesktopBackend } from './ipc.js';
import { toWireEvent } from './ipc.js';
import { mcpView } from './mcp-view.js';
import { rulesView } from './rules-view.js';
import { loadDesktopState, saveDesktopState } from './state.js';

const IGNORED_GLOBS = ['.git/**', 'node_modules/**', '.cake/**', 'dist/**', 'release/**'];
const FILE_RESULT_LIMIT = 50;
const RECENT_LIMIT = 8;

/** The file-launching deps come from Electron; without them the fix cannot run. */
function unavailable(): never {
  throw new Error('Opening files is only available in the desktop app');
}

export interface ControllerDeps {
  /** `userData/state.json` in production; a temp file in tests. */
  stateFile: string;
  /** Sends a main → renderer event. */
  send(channel: string, payload: unknown): void;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Opens a file in the user's editor; Electron passes `shell.openPath`. */
  openFile?: (file: string) => Promise<string>;
  /** Shows a file in the file manager; Electron passes `shell.showItemInFolder`. */
  revealFile?: (file: string) => void;
}

interface ActiveWorkspace {
  cwd: string;
  store: SessionStore;
  system: string;
  /** System prompt without the project-instructions section; a Slice layer. */
  systemBase: string;
  projectSections: ProjectSection[];
  /** Layered settings for this workspace; the runtime lists are merged from these. */
  settings: SettingsLayer[];
  /** Rate-card additions from this workspace's config. */
  pricing: PricingOverrides;
  mcp: McpBundle;
  embedder: Embedder | undefined;
  model: ModelSpec;
  mode: PermissionMode;
  session: SessionMeta;
}

/**
 * One turn in flight. Every piece of run-scoped state lives here, which is what
 * lets a second session start while the first is still waiting on the provider.
 */
interface ActiveRun {
  /** The conversation this turn belongs to, so its traffic can be routed back. */
  sessionId: string;
  abort: AbortController;
  /** Work attributed to the Slice's "This turn" layer, for this run only. */
  entries: ContextEntryPayload[];
  /** Approvals this run is waiting on, by id. */
  approvals: Map<string, (decision: PermissionDecision) => void>;
}

/**
 * Owns everything scoped to one open workspace: session store, MCP connections,
 * provider registry, and every turn in flight. Electron IPC only delegates here,
 * so all agent behavior stays identical to the CLI.
 */
export class WorkspaceController implements DesktopBackend {
  private registry: ProviderRegistry;
  private config: ReturnType<typeof loadConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string | undefined;
  private readonly stateFile: string;
  private readonly send: (channel: string, payload: unknown) => void;
  private readonly openFile: (file: string) => Promise<string>;
  private readonly revealFile: (file: string) => void;

  private active: ActiveWorkspace | undefined;
  /** Global settings, used for the panel until a workspace is open. */
  private fallbackSettings: SettingsLayer[] = [];
  /** The MCP panel's last state, and the rows it was built from. */
  private mcpSnapshot: McpStatus = mcpView([], [], { global: null, project: null }, []);
  private mcpRows: McpServerStatus[] = [];
  private recents: string[] = [];
  /** Turn in flight, keyed by session. A session appears at most once. */
  private readonly runs = new Map<string, ActiveRun>();
  private approvalSeq = 0;

  constructor(deps: ControllerDeps) {
    this.stateFile = deps.stateFile;
    this.send = deps.send;
    this.env = deps.env ?? (process.env as Record<string, string | undefined>);
    this.homeDir = deps.homeDir;
    this.openFile = deps.openFile ?? (async () => unavailable());
    this.revealFile = deps.revealFile ?? (() => unavailable());
    this.config = loadConfig({ env: this.env, homeDir: deps.homeDir });
    this.registry = createDefaultRegistry(this.config, this.env);
  }

  /** Reopen the last workspace when it still exists, then report the full state. */
  async init(): Promise<InitPayload> {
    this.fallbackSettings = await loadSettingsLayers({ homeDir: this.homeDir });
    const state = await loadDesktopState(this.stateFile);
    this.recents = await this.existingDirs(state.recents ?? []);
    if (!this.active && state.lastWorkspace) {
      try {
        await this.openWorkspace(state.lastWorkspace);
      } catch {
        await this.writeState(undefined);
      }
    }
    return this.snapshot();
  }

  async openWorkspace(cwd: string): Promise<InitPayload> {
    if (this.runs.size > 0) throw new Error('Cannot switch workspaces while a turn is running');
    const previousMode = this.active?.mode;
    await this.closeActive();

    const settings = await loadSettingsLayers({ cwd, homeDir: this.homeDir });
    // Config is re-read per workspace so a project can price its own models.
    const workspaceConfig = loadConfig({ cwd, env: this.env, homeDir: this.homeDir });
    const projectSections = await loadProjectSections(cwd);
    const projectInstructions =
      projectSections.length > 0
        ? projectSections.map((section) => `## ${section.path}\n${section.text}`).join('\n\n')
        : undefined;
    const system = buildSystemPrompt({ cwd, projectInstructions });
    const systemBase = buildSystemPrompt({ cwd });
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
        systemBase,
        projectSections,
        settings,
        pricing: workspaceConfig.pricing,
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

    this.recents = [cwd, ...this.recents.filter((item) => item !== cwd)].slice(0, RECENT_LIMIT);
    await this.writeState(cwd);
    this.setMcpBundle(mcp, false);
    return this.snapshot();
  }

  /** Layer-by-layer composition of the context window for the desktop Slice. */
  contextLayers(): ContextPayload {
    const active = this.requireActive();
    const provider = this.registry.get(active.model.provider);
    return buildContextMap({
      systemBase: active.systemBase,
      projectSections: active.projectSections,
      messages: active.store.messages(active.session.id),
      turn: this.runs.get(active.session.id)?.entries ?? [],
      maxContext: provider.capabilities(active.model.modelId).maxContext,
    });
  }

  listSessions(): SessionMeta[] {
    const active = this.requireActive();
    return active.store.list(active.cwd);
  }

  newSession(): { session: SessionMeta; messages: []; plan: [] } {
    const active = this.requireActive();
    const session = active.store.create({
      cwd: active.cwd,
      provider: active.model.provider,
      model: active.model.modelId,
    });
    active.session = session;
    return { session, messages: [], plan: [] };
  }

  /**
   * Branch a session and switch to the branch. The transcript on screen is the
   * same conversation; only where the next turn gets written changes.
   */
  forkSession(id: string): {
    session: SessionMeta;
    messages: ReturnType<SessionStore['messages']>;
    plan: TaskItem[];
  } {
    const active = this.requireActive();
    if (this.runs.has(id)) throw new Error('Cannot fork a session while its turn is running');
    if (!active.store.get(id)) throw new Error(`Unknown session "${id}"`);
    const child = active.store.fork(id);
    this.activateSession(child);
    return {
      session: active.session,
      messages: active.store.messages(child.id),
      plan: active.store.plan(child.id),
    };
  }

  /**
   * Write a session's transcript as Markdown. A relative `file` is resolved
   * against the workspace and has to stay inside it, so a path typed in the
   * composer cannot drop a file somewhere else on disk.
   */
  exportSession(id: string, file?: string): ExportResult {
    const active = this.requireActive();
    if (!file || file.trim() === '') return exportSessionMarkdown(active.store, id);
    const target = path.resolve(active.cwd, file.trim());
    const inside = path.relative(active.cwd, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error('Export path has to stay inside the workspace');
    }
    return exportSessionMarkdown(active.store, id, target);
  }

  openSession(id: string): {
    session: SessionMeta;
    messages: ReturnType<SessionStore['messages']>;
    plan: TaskItem[];
  } {
    const active = this.requireActive();
    const found = active.store.get(id);
    if (!found) throw new Error(`Unknown session "${id}"`);
    this.activateSession(found);
    return {
      session: active.session,
      messages: active.store.messages(id),
      plan: active.store.plan(id),
    };
  }

  renameSession(id: string, title: string): SessionMeta[] {
    const active = this.requireActive();
    if (!active.store.get(id)) throw new Error(`Unknown session "${id}"`);
    active.store.rename(id, title);
    if (active.session.id === id) active.session = active.store.get(id) ?? active.session;
    return active.store.list(active.cwd);
  }

  deleteSession(id: string): {
    session: SessionMeta;
    messages: ReturnType<SessionStore['messages']>;
    plan: TaskItem[];
  } | null {
    const active = this.requireActive();
    const found = active.store.get(id);
    if (!found) throw new Error(`Unknown session "${id}"`);
    // A running turn writes its transcript back when it lands; the rows must
    // still be there for it to write to.
    if (this.runs.has(id)) throw new Error('Cannot delete a session while its turn is running');
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
    return {
      session: active.session,
      messages: active.store.messages(active.session.id),
      plan: active.store.plan(active.session.id),
    };
  }

  async run(sessionId: string, prompt: string, images: string[] = []) {
    const active = this.requireActive();
    const model = this.sessionModel(active, sessionId);
    if (this.runs.has(sessionId)) throw new Error('A turn is already running in this session');

    const run: ActiveRun = {
      sessionId,
      abort: new AbortController(),
      entries: [],
      approvals: new Map(),
    };
    this.runs.set(sessionId, run);
    // Name the session as its first turn starts, not when it ends: with two
    // turns in flight the rail has to say which row is which while both run.
    active.store.setTitleIfEmpty(sessionId, prompt);
    this.addTurnEntry(
      run,
      'Prompt',
      estimateTextTokens(prompt) + images.length * ESTIMATED_IMAGE_TOKENS,
    );
    const emit = (event: AgentEvent) => {
      // Persist as it happens: a turn that is stopped mid-way keeps its plan.
      if (event.type === 'plan') active.store.savePlan(sessionId, event.tasks);
      this.trackTurnEvent(run, event);
      this.send('agent:event', { sessionId, event: toWireEvent(event) });
    };

    try {
      const tools = buildToolCatalog(active.embedder, active.mcp.tools, {
        registry: this.registry,
        model,
        systemBase: active.system,
        mode: active.mode,
        rules: mergeSettings(active.settings),
        pricing: active.pricing,
        abortSignal: run.abort.signal,
        onEvent: emit,
      });
      const provider = this.registry.get(model.provider);
      const result = await runTurn({
        cwd: active.cwd,
        registry: this.registry,
        model,
        system: active.system,
        mode: active.mode,
        rules: mergeSettings(active.settings),
        tools,
        history: active.store.messages(sessionId),
        prompt,
        images,
        maxContext: provider.capabilities(model.modelId).maxContext,
        pricing: active.pricing,
        embedder: active.embedder,
        ctx: this.toolContext(active, sessionId, run),
        abortSignal: run.abort.signal,
        onEvent: emit,
        onNote: (note) => this.send('agent:note', { sessionId, note }),
      });

      active.store.saveMessages(sessionId, result.messages);
      active.store.addTurnUsage(sessionId, result.lines);
      // Only the session on screen moves the workspace's idea of "the session".
      if (active.session.id === sessionId)
        active.session = active.store.get(sessionId) ?? active.session;
      return {
        sessionId,
        usage: result.usage,
        costUsd: result.costUsd,
        text: result.text,
      };
    } finally {
      this.runs.delete(sessionId);
      this.denyApprovals(run);
    }
  }

  /** Stop one session's turn. A session that is not running has nothing to stop. */
  abort(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.abort.abort();
    this.denyApprovals(run);
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    for (const run of this.runs.values()) {
      const resolve = run.approvals.get(id);
      if (!resolve) continue;
      run.approvals.delete(id);
      resolve(decision);
      return;
    }
    throw new Error(`Unknown permission request "${id}"`);
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

  /** Persist a rate for this workspace and re-read the config it lives in. */
  async setPricing(pattern: string, rates: Pricing | null): Promise<InitPayload> {
    const active = this.requireActive();
    const key = pattern.trim();
    if (!key) throw new Error('Rate pattern cannot be empty');
    await setPricingEntry(active.cwd, key, rates);
    active.pricing = loadConfig({ cwd: active.cwd, env: this.env, homeDir: this.homeDir }).pricing;
    return this.snapshot();
  }

  /**
   * The cost tab on its own, so a finished turn or a switched session can refresh
   * the board without rebuilding every other panel.
   */
  getCost(): Promise<CostPayload> {
    return Promise.resolve(this.costSnapshot(this.modelHandle(), this.active));
  }

  /**
   * Add, drop, or reorder a rule, then re-read the files so the next turn runs
   * with what the panel just showed.
   */
  async addRule(list: RuleList, scope: RuleScope, rule: string): Promise<InitPayload> {
    await appendRule(this.ruleTarget(list, scope), rule);
    return this.reloadSettings();
  }

  async removeRule(list: RuleList, scope: RuleScope, rule: string): Promise<InitPayload> {
    await dropRule(this.ruleTarget(list, scope), rule);
    return this.reloadSettings();
  }

  async moveRule(
    list: RuleList,
    scope: RuleScope,
    rule: string,
    delta: number,
  ): Promise<InitPayload> {
    await shiftRule(this.ruleTarget(list, scope), rule, delta);
    return this.reloadSettings();
  }

  private ruleTarget(list: RuleList, scope: RuleScope): RuleTarget {
    const active = this.requireActive();
    return { cwd: active.cwd, homeDir: this.homeDir, scope, list };
  }

  private async reloadSettings(): Promise<InitPayload> {
    const active = this.active;
    const layers = await loadSettingsLayers({
      cwd: active?.cwd ?? process.cwd(),
      homeDir: this.homeDir,
    });
    if (active) active.settings = layers;
    else this.fallbackSettings = layers;
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
      hasWorkspace: Boolean(this.active),
    });
  }

  /**
   * Store a key in the global config, then rebuild the registry so the next turn
   * — and the index — can actually use it.
   */
  async setProviderKey(provider: string, key: string): Promise<InitPayload> {
    await setProviderApiKey(this.homeDir, provider, key);
    this.reloadProviders();
    return this.snapshot();
  }

  /** Build or refresh the semantic index, reporting progress as agent notes. */
  async rebuildIndex(): Promise<string> {
    const active = this.requireActive();
    if (!active.embedder) {
      throw new Error('Indexing needs embeddings; set an OpenAI key first');
    }
    if (this.runs.size > 0) throw new Error('Cannot rebuild the index while a turn is running');
    const store = CodeIndexStore.open(defaultIndexFile(active.cwd));
    try {
      const summary = await indexCodebase({
        cwd: active.cwd,
        store,
        embedder: active.embedder,
        // A rebuild belongs to the workspace, not to one session's turn.
        onProgress: (message) =>
          this.send('agent:note', { note: { kind: 'index', text: message } }),
      });
      const truncated = summary.truncated ? ' (chunk cap reached; some files skipped)' : '';
      return `Indexed ${summary.chunks} chunks from ${summary.indexedFiles} files${truncated}.`;
    } finally {
      store.close();
    }
  }

  /** Open a config file, creating an empty valid one when the check found nothing. */
  async openDoctorFile(target: DoctorFileTargetName): Promise<string> {
    const file = await ensureDoctorFile(target, {
      cwd: this.active?.cwd ?? process.cwd(),
      homeDir: this.homeDir,
    });
    const failure = await this.openFile(file);
    if (failure) throw new Error(`Could not open ${file}: ${failure}`);
    return file;
  }

  /** A SQLite store is not editable as text, so the fix only shows it in the file manager. */
  async revealDoctorStore(target: DoctorStoreTargetName): Promise<string> {
    const file = doctorStorePath(target, {
      cwd: this.requireActive().cwd,
      homeDir: this.homeDir,
    });
    this.revealFile(file);
    return file;
  }

  /** Re-read the global config after a key change; providers hold their key at build time. */
  private reloadProviders(): void {
    this.config = loadConfig({ env: this.env, homeDir: this.homeDir });
    this.registry = createDefaultRegistry(this.config, this.env);
    if (this.active) this.active.embedder = resolveEmbedder(this.registry);
  }

  async dispose(): Promise<void> {
    await this.closeActive();
  }

  private snapshot(): InitPayload {
    const active = this.active;
    const providers = this.providerSummaries();
    const model = this.modelHandle();
    return {
      version: VERSION,
      workspace: active ? { cwd: active.cwd, sessionId: active.session.id } : null,
      recents: this.recents,
      providers,
      model,
      attachments: {
        vision: this.registry.get(model.provider).capabilities(model.modelId).vision,
        perTurn: MAX_IMAGES_PER_TURN,
        maxBytes: MAX_IMAGE_BYTES,
      },
      mode: active?.mode ?? 'default',
      rules: rulesView(active?.settings ?? this.fallbackSettings, {
        global: globalSettingsPath(this.homeDir),
        project: active ? settingsPaths(active.cwd, this.homeDir).project : null,
      }),
      mcpStatus: this.mcpStatus(),
      missingKeys: providers.filter((item) => !item.hasKey).map((item) => item.id),
      cost: this.costSnapshot(model, active),
      plan: active ? active.store.plan(active.session.id) : [],
    };
  }

  /**
   * The rate card and the spend board as the Inspector shows them: what answers
   * for the open model, what each turn, model and child agent cost, and what the
   * whole workspace cost across its sessions.
   */
  private costSnapshot(model: ModelHandle, active: ActiveWorkspace | undefined): CostPayload {
    const overrides = active?.pricing ?? {};
    const match = resolvePricing(model, overrides);
    const row = (pattern: string, pricing: Pricing): PricingRow => ({
      pattern,
      inputPer1M: pricing.inputPer1M,
      outputPer1M: pricing.outputPer1M,
    });
    return {
      model,
      effective: match ? row(match.pattern, match.pricing) : null,
      source: match?.source ?? null,
      overrides: Object.entries(overrides)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pattern, pricing]) => row(pattern, pricing)),
      builtin: BUILTIN_PRICING.map((entry) => row(entry.pattern, entry.pricing)),
      configFile: active ? configPaths(active.cwd).project : null,
      board: active ? buildCostBoard(active.store.turnUsage(active.session.id)) : null,
      rollup: active
        ? { costUsd: active.session.costUsd, totalTokens: active.session.totalTokens }
        : null,
      workspace: active ? active.store.workspaceUsage(active.cwd) : null,
    };
  }

  /** The model the panels price against: the open session's, or the configured default. */
  private modelHandle(): ModelHandle {
    const active = this.active;
    const providerId = active?.model.provider ?? this.defaultProviderId();
    const provider = this.registry.get(providerId);
    const fallbackModelId =
      providerId === this.config.provider && this.config.model
        ? this.config.model
        : provider.defaultModelId;
    return active?.model ?? { provider: providerId, modelId: fallbackModelId };
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

  private mcpStatus(): McpStatus {
    return { ...this.mcpSnapshot, files: this.mcpFiles() };
  }

  /** The two files servers can be declared in; the workspace one needs an open workspace. */
  private mcpFiles(): Record<RuleScopeName, string | null> {
    const paths = mcpConfigPaths(this.active?.cwd ?? process.cwd(), this.homeDir);
    return { global: paths.global, project: this.active ? paths.project : null };
  }

  /**
   * Publish a fresh connect. `report` is false when the change came from opening
   * a workspace, so a switch does not read as a set of servers being added.
   */
  private setMcpBundle(bundle: McpBundle | undefined, report: boolean): void {
    const rows = bundle?.status ?? [];
    this.mcpSnapshot = mcpView(
      rows,
      bundle?.warnings ?? [],
      this.mcpFiles(),
      report ? this.mcpRows : rows,
    );
    this.mcpRows = rows;
    this.send('mcp:status', this.mcpStatus());
  }

  private mcpTarget(scope: RuleScopeName): McpTarget {
    const active = this.requireActive();
    if (this.runs.size > 0) throw new Error('Cannot change MCP servers while a turn is running');
    return { cwd: active.cwd, homeDir: this.homeDir, scope };
  }

  /** Reconnect, then tell the panel what the connect changed. */
  async reloadMcp(): Promise<InitPayload> {
    const active = this.requireActive();
    if (this.runs.size > 0) throw new Error('Cannot reload MCP while a turn is running');
    await active.mcp.close();
    active.mcp = await openMcpServers({ cwd: active.cwd });
    this.setMcpBundle(active.mcp, true);
    return this.snapshot();
  }

  /**
   * Write one server entry and reconnect, so the panel shows the live result of
   * what was just saved rather than a promise about it.
   */
  async setMcpServer(scope: RuleScopeName, draft: McpDraft): Promise<InitPayload> {
    await writeServer(this.mcpTarget(scope), draft);
    return this.reloadMcp();
  }

  async removeMcpServer(scope: RuleScopeName, name: string): Promise<InitPayload> {
    await dropServer(this.mcpTarget(scope), name);
    return this.reloadMcp();
  }

  async setMcpEnabled(scope: RuleScopeName, name: string, enabled: boolean): Promise<InitPayload> {
    await switchServer(this.mcpTarget(scope), name, enabled);
    return this.reloadMcp();
  }

  private toolContext(active: ActiveWorkspace, sessionId: string, run: ActiveRun): ToolContext {
    return {
      cwd: active.cwd,
      // Resume where the session left off instead of starting an empty list.
      tasks: active.store.plan(sessionId),
      askPermission: (request) => this.askPermission(run, request),
      log: () => {},
    };
  }

  private askPermission(run: ActiveRun, request: PermissionRequest): Promise<PermissionDecision> {
    if (run.abort.signal.aborted) return Promise.resolve('deny');
    const id = `p${++this.approvalSeq}`;
    return new Promise<PermissionDecision>((resolve) => {
      run.approvals.set(id, resolve);
      this.send('permission:request', { sessionId: run.sessionId, request: { id, ...request } });
    });
  }

  /** A turn that ends, in success or in failure, cannot leave a card up. */
  private denyApprovals(run: ActiveRun): void {
    for (const resolve of run.approvals.values()) resolve('deny');
    run.approvals.clear();
  }

  /**
   * The session a turn will write to, and the model it runs on. Any stored
   * session can be asked — that is what lets a second one start while the
   * first is still waiting — so the model comes from the session's own row.
   */
  private sessionModel(active: ActiveWorkspace, sessionId: string): ModelSpec {
    const found = active.store.get(sessionId);
    if (!found) throw new Error(`Unknown session "${sessionId}"`);
    const model = this.resolveSessionModel(found);
    if (model.provider !== found.provider || model.modelId !== found.model) {
      active.store.updateModel(found.id, model.provider, model.modelId);
    }
    return model;
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

  private async writeState(lastWorkspace: string | undefined): Promise<void> {
    await saveDesktopState(this.stateFile, { lastWorkspace, recents: this.recents });
  }

  /** Recents go stale when folders move, so only live directories are offered. */
  private async existingDirs(dirs: string[]): Promise<string[]> {
    const alive: string[] = [];
    for (const dir of dirs) {
      try {
        const info = await stat(dir);
        if (info.isDirectory()) alive.push(dir);
      } catch {
        // Unreadable or gone: drop it from the list.
      }
    }
    return alive.slice(0, RECENT_LIMIT);
  }

  private addTurnEntry(run: ActiveRun, label: string, tokens: number): void {
    if (tokens <= 0) return;
    const found = run.entries.find((entry) => entry.label === label);
    if (found) found.tokens += tokens;
    else run.entries.push({ label, tokens });
  }

  /** Keeps the Slice's turn layer honest while a run is in flight. */
  private trackTurnEvent(run: ActiveRun, event: AgentEvent): void {
    switch (event.type) {
      case 'text-delta':
        this.addTurnEntry(run, 'Reply', Math.max(1, estimateTextTokens(event.delta)));
        break;
      case 'tool-call':
        this.addTurnEntry(
          run,
          `→ ${event.toolName}`,
          estimateTextTokens(JSON.stringify(event.input ?? {})),
        );
        break;
      case 'tool-result':
        this.addTurnEntry(
          run,
          `← ${event.toolName}`,
          estimateTextTokens(
            typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? ''),
          ),
        );
        break;
      default:
        break;
    }
  }

  private async closeActive(): Promise<void> {
    for (const run of this.runs.values()) {
      run.abort.abort();
      this.denyApprovals(run);
    }
    this.runs.clear();
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    await active.mcp.close();
    active.store.close();
    this.setMcpBundle(undefined, false);
  }
}
