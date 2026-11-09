import type { ModelMessage } from 'ai';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { CheckpointStore } from '../core/checkpoints.js';
import { formatCost, spendLabel, unpricedTokens } from '../core/cost.js';
import { buildCostBoard } from '../core/cost-board.js';
import type { AgentEvent } from '../core/events.js';
import { planProgress } from '../core/plan.js';
import type { PricingOverrides } from '../core/pricing.js';
import { createTrace } from '../observability/trace.js';
import type { PermissionRules } from '../permissions/rules.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import type { Embedder } from '../rag/embedder.js';
import { buildToolCatalog } from '../runtime/toolset.js';
import { runTurn } from '../runtime/turn.js';
import { exportSessionMarkdown } from '../session/export.js';
import type { SessionMeta, SessionStore } from '../session/store.js';
import type {
  CakeTool,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  TaskItem,
  TaskStatus,
  ToolContext,
} from '../tools/types.js';
import { revertTurn } from './revert.js';

type EntryRole = 'user' | 'assistant' | 'tool' | 'error' | 'info';

interface TranscriptEntry {
  id: number;
  role: EntryRole;
  label?: string;
  prefix?: string;
  text: string;
  meta?: string;
}

interface PendingApproval {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export interface AppProps {
  registry: ProviderRegistry;
  model: ModelSpec;
  permissionMode: PermissionMode;
  rules: PermissionRules;
  system: string;
  store: SessionStore;
  session: SessionMeta;
  initialMessages: ModelMessage[];
  maxContext: number;
  /** Rate-card additions from config; costs use them for every model. */
  pricing: PricingOverrides;
  /** Where each turn's file changes are archived, so /revert can undo them. */
  checkpoints: CheckpointStore;
  embedder?: Embedder;
  mcpTools?: CakeTool[];
}

const COMMANDS = [
  '/help            show this list',
  '/clear           start a new session',
  '/fork            branch this conversation into a new session',
  '/export [file]   write the transcript as Markdown',
  '/revert [n]      undo the file changes of turn n (newest if omitted); "list" shows them',
  '/model <id>      switch model id (same provider)',
  '/cost            session token and cost totals',
  '/exit            quit (or Ctrl+C)',
].join('\n');

const PLAN_MARKS: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

function preview(value: unknown, max = 160): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const line = (raw ?? '').split('\n').find((item) => item.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function App(props: AppProps) {
  const {
    registry,
    permissionMode,
    rules,
    system,
    store,
    maxContext,
    pricing,
    checkpoints,
    embedder,
  } = props;
  const mcpTools = props.mcpTools ?? [];
  const { exit } = useApp();
  const [model, setModel] = useState<ModelSpec>(props.model);
  const [session, setSession] = useState<SessionMeta>(props.session);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<ModelMessage[]>(props.initialMessages);
  const nextId = useRef(0);
  const approvalQueue = useRef<Promise<void>>(Promise.resolve());
  const abortedRef = useRef(false);
  const [trace] = useState(() => createTrace(process.cwd()));
  const traceAnnounced = useRef(false);
  const [plan, setPlan] = useState<TaskItem[]>(() => store.plan(props.session.id));

  useEffect(() => () => store.close(), [store]);

  const addEntry = (entry: Omit<TranscriptEntry, 'id'>) => {
    const id = nextId.current++;
    setEntries((prev) => [...prev, { ...entry, id }]);
  };

  function handleCommand(raw: string): void {
    const [name = '', ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (name) {
      case 'exit':
      case 'quit':
        exit();
        return;
      case 'help':
        addEntry({ role: 'info', text: COMMANDS });
        return;
      case 'clear': {
        const next = store.create({
          cwd: process.cwd(),
          provider: model.provider,
          model: model.modelId,
        });
        setSession(next);
        setPlan([]);
        historyRef.current = [];
        setEntries([]);
        setStreaming('');
        addEntry({ role: 'info', text: `new session ${next.id.slice(0, 8)}` });
        return;
      }
      case 'fork': {
        const next = store.fork(session.id);
        setSession(next);
        historyRef.current = store.messages(next.id);
        setPlan(store.plan(next.id));
        addEntry({
          role: 'info',
          // The transcript on screen does not change: only where it goes next.
          text: `forked → ${next.id.slice(0, 8)}${next.title ? ` (${next.title})` : ''}`,
        });
        return;
      }
      case 'export': {
        try {
          const written = exportSessionMarkdown(store, session.id, arg || undefined);
          const count = written.pictures === 1 ? '1 picture' : `${written.pictures} pictures`;
          // A folder of pictures beside the file is a surprise unless the note says it is there.
          const extras = written.assetFolder ? ` + ${count} → ${written.assetFolder}` : '';
          addEntry({ role: 'info', text: `transcript → ${written.file}${extras}` });
        } catch (err) {
          addEntry({ role: 'error', text: `[export] ${(err as Error).message}` });
        }
        return;
      }
      case 'revert': {
        revertTurn(checkpoints, arg).then(
          (text) => addEntry({ role: 'info', text }),
          (err: unknown) => addEntry({ role: 'error', text: `[revert] ${(err as Error).message}` }),
        );
        return;
      }
      case 'model': {
        if (!arg) {
          addEntry({ role: 'info', text: `model: ${model.provider}/${model.modelId}` });
          return;
        }
        const next: ModelSpec = { ...model, modelId: arg };
        setModel(next);
        store.updateModel(session.id, next.provider, next.modelId);
        addEntry({ role: 'info', text: `model → ${next.provider}/${next.modelId}` });
        return;
      }
      case 'cost': {
        const meta = store.get(session.id) ?? session;
        const board = buildCostBoard(store.turnUsage(session.id));
        const spend = spendLabel(board.totals.costUsd, board.totals.unpricedTokens);
        const work = board.work
          .map((group) => `${group.label} ${spendLabel(group.costUsd, group.unpricedTokens)}`)
          .join(' · ');
        addEntry({
          role: 'info',
          text: `session ${meta.id.slice(0, 8)} · ${meta.totalTokens} tokens · ${spend}${
            work ? ` · ${work}` : ''
          }${board.totals.turns === 0 ? ' · no per-turn detail saved' : ''}`,
        });
        return;
      }
      default:
        addEntry({ role: 'info', text: `unknown command /${name} — try /help` });
    }
  }

  function askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (abortedRef.current) return Promise.resolve('deny');
    const decision = approvalQueue.current.then(
      () =>
        new Promise<PermissionDecision>((resolve) => {
          if (abortedRef.current) {
            resolve('deny');
            return;
          }
          setApproval({ request, resolve });
        }),
    );
    approvalQueue.current = decision.then(() => undefined);
    return decision;
  }

  async function submit() {
    const typed = input.trim();
    if (!typed || busy) return;
    if (typed.startsWith('/')) {
      setInput('');
      handleCommand(typed);
      return;
    }

    setInput('');
    setBusy(true);
    abortedRef.current = false;
    addEntry({ role: 'user', text: typed });

    const controller = new AbortController();
    abortRef.current = controller;

    let acc = '';
    let sawToolCall = false;
    const flushText = () => {
      if (!acc.trim()) return;
      addEntry({ role: 'assistant', text: acc });
      acc = '';
      setStreaming('');
    };

    function handleEvent(event: AgentEvent): void {
      trace?.record(event);
      if (trace && !traceAnnounced.current) {
        traceAnnounced.current = true;
        addEntry({ role: 'info', text: `trace → ${trace.file}` });
      }
      switch (event.type) {
        case 'text-delta':
          acc += event.delta;
          setStreaming(acc);
          break;
        case 'tool-call':
          sawToolCall = true;
          flushText();
          addEntry({
            role: 'tool',
            prefix: '→',
            label: event.toolName,
            text: preview(event.input),
          });
          break;
        case 'tool-result':
          addEntry({
            role: 'tool',
            prefix: '←',
            label: event.toolName,
            text: preview(event.output),
          });
          break;
        case 'tool-error':
          addEntry({
            role: 'error',
            prefix: '✗',
            label: event.toolName,
            text: event.error.message,
          });
          break;
        case 'subagent-start':
          flushText();
          addEntry({
            role: 'info',
            text: `↳ ${event.agentType} agent: ${preview(event.prompt)}`,
          });
          break;
        case 'subagent-end':
          addEntry({
            role: 'info',
            text: `↳ ${event.agentType} done · ${event.usage.totalTokens} tokens · ${formatCost(event.costUsd)}`,
          });
          break;
        case 'plan':
          setPlan(event.tasks);
          store.savePlan(session.id, event.tasks);
          break;
      }
    }

    const cwd = process.cwd();
    const ctx: ToolContext = {
      cwd,
      askPermission,
      log: () => {},
      tasks: plan,
    };
    const tools = buildToolCatalog(embedder, mcpTools, {
      registry,
      model,
      systemBase: system,
      mode: permissionMode,
      rules,
      pricing,
      abortSignal: controller.signal,
      onEvent: handleEvent,
    });

    try {
      const result = await runTurn({
        cwd,
        registry,
        model,
        system,
        mode: permissionMode,
        rules,
        tools,
        history: historyRef.current,
        prompt: typed,
        maxContext,
        pricing,
        checkpoints,
        embedder,
        ctx,
        abortSignal: controller.signal,
        onEvent: handleEvent,
        onNote: (note) =>
          addEntry({
            role: 'info',
            // The terminal has no cards, so the files it used read as one line.
            text: `${note.kind}: ${note.text}${
              note.hits && note.hits.length > 0
                ? ` (${note.hits.map((hit) => `${hit.path}:${hit.startLine}`).join(', ')})`
                : ''
            }`,
          }),
      });

      historyRef.current = result.messages;
      store.setTitleIfEmpty(session.id, typed);
      store.saveMessages(session.id, result.messages);
      store.addTurnUsage(
        session.id,
        result.lines,
        result.checkpointId ? { checkpointId: result.checkpointId, prompt: typed } : undefined,
      );
      const updated = store.get(session.id);
      if (updated) setSession(updated);
      const meta = `${result.usage.totalTokens} tokens · ${spendLabel(
        result.costUsd,
        unpricedTokens(result.lines),
      )}`;
      if (acc.trim()) {
        setStreaming('');
        addEntry({ role: 'assistant', text: acc, meta });
      } else if (!sawToolCall) {
        addEntry({ role: 'assistant', text: '(no output)', meta });
      } else {
        addEntry({ role: 'info', text: meta });
      }
      if (controller.signal.aborted) addEntry({ role: 'info', text: '(cancelled)' });
    } catch (err) {
      if (acc.trim()) {
        setStreaming('');
        addEntry({ role: 'assistant', text: acc });
      }
      addEntry({
        role: 'error',
        text: controller.signal.aborted ? '(cancelled)' : `[error] ${(err as Error).message}`,
      });
    } finally {
      setStreaming('');
      setBusy(false);
      abortRef.current = null;
    }
  }

  useInput((chunk, key) => {
    if (key.ctrl && chunk === 'c') {
      if (approval) {
        approval.resolve('deny');
        setApproval(null);
      }
      if (busy && abortRef.current) {
        abortedRef.current = true;
        abortRef.current.abort();
        return;
      }
      exit();
      return;
    }
    if (approval) {
      if (chunk === 'y' || chunk === 'Y' || key.return) {
        approval.resolve('allow');
        setApproval(null);
      } else if (chunk === 'n' || chunk === 'N' || key.escape) {
        approval.resolve('deny');
        setApproval(null);
      }
      return;
    }
    if (busy) return;
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInput('');
      return;
    }
    if (chunk && !key.ctrl && !key.meta) {
      setInput((value) => value + chunk);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold color="cyan">
          cake
        </Text>
        <Text dimColor>
          {' '}
          {model.provider}/{model.modelId} · mode={permissionMode} · session{' '}
          {session.id.slice(0, 8)} · /help · Ctrl+C to quit
        </Text>
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {entries.map((entry) => {
          if (entry.role === 'user') {
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1}>
                <Text bold color="green">
                  › you
                </Text>
                <Text>{entry.text}</Text>
              </Box>
            );
          }
          if (entry.role === 'assistant') {
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1}>
                <Text bold color="magenta">
                  ‹ cake
                </Text>
                <Text>{entry.text}</Text>
                {entry.meta ? <Text dimColor>{entry.meta}</Text> : null}
              </Box>
            );
          }
          if (entry.role === 'info') {
            return (
              <Box key={entry.id} marginBottom={1}>
                <Text dimColor>{entry.text}</Text>
              </Box>
            );
          }
          return (
            <Box key={entry.id} marginBottom={entry.role === 'error' ? 1 : 0}>
              <Text bold color={entry.role === 'error' ? 'red' : 'cyan'} dimColor>
                {entry.prefix} {entry.label}
              </Text>
              <Text dimColor> {entry.text}</Text>
            </Box>
          );
        })}

        {busy && streaming ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="magenta">
              ‹ cake
            </Text>
            <Text>{streaming}</Text>
          </Box>
        ) : null}
      </Box>

      {plan.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          <Text dimColor>
            plan · {planProgress(plan).done}/{plan.length} done
          </Text>
          {plan.map((task) => (
            <Text
              key={task.id}
              color={task.status === 'in_progress' ? 'yellow' : undefined}
              dimColor={task.status === 'completed'}
            >
              {`${PLAN_MARKS[task.status]} ${task.id}. ${task.subject}`}
            </Text>
          ))}
        </Box>
      ) : null}

      {approval ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginBottom={1}
        >
          <Text>
            <Text bold color="yellow">
              approval
            </Text>{' '}
            {approval.request.tool} ({approval.request.permission}) → {approval.request.target}
          </Text>
          {approval.request.preview ? (
            <Text dimColor>
              {approval.request.preview.path ?? 'change'} · +{approval.request.preview.diff.adds} −
              {approval.request.preview.diff.removes}
            </Text>
          ) : null}
          {approval.request.danger ? (
            <Text bold color="red">
              danger: {approval.request.danger}
            </Text>
          ) : null}
          <Text dimColor>[y/Enter] allow · [n/Esc] deny</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text bold color="green">
          {'> '}
        </Text>
        <Text>{input}</Text>
        {busy ? <Text dimColor>{' (working… Ctrl+C to cancel)'}</Text> : null}
      </Box>
    </Box>
  );
}
