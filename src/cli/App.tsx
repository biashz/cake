import type { ModelMessage } from 'ai';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { runAgent } from '../core/agent.js';
import { createHistorySummarizer, maybeCompress } from '../core/context.js';
import { formatCost } from '../core/cost.js';
import { expandFileReferences } from '../core/mentions.js';
import type { PermissionRules } from '../permissions/rules.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { expandCodebaseMention } from '../rag/codebase-mention.js';
import type { Embedder } from '../rag/embedder.js';
import { createRagTools } from '../rag/tools.js';
import type { SessionMeta, SessionStore } from '../session/store.js';
import { buildToolSet, createDefaultTools } from '../tools/registry.js';
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ToolContext,
} from '../tools/types.js';

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
  embedder?: Embedder;
}

const COMMANDS = [
  '/help            show this list',
  '/clear           start a new session',
  '/model <id>      switch model id (same provider)',
  '/cost            session token and cost totals',
  '/exit            quit (or Ctrl+C)',
].join('\n');

function preview(value: unknown, max = 160): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const line = (raw ?? '').split('\n').find((item) => item.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function App(props: AppProps) {
  const { registry, permissionMode, rules, system, store, maxContext, embedder } = props;
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
        historyRef.current = [];
        setEntries([]);
        setStreaming('');
        addEntry({ role: 'info', text: `new session ${next.id.slice(0, 8)}` });
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
        addEntry({
          role: 'info',
          text: `session ${meta.id.slice(0, 8)} · ${meta.totalTokens} tokens · ${formatCost(meta.costUsd)}`,
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

    let pending: ModelMessage[] = [...historyRef.current, { role: 'user', content: typed }];
    try {
      const cwd = process.cwd();
      const codebase = await expandCodebaseMention(typed, {
        cwd,
        embedder,
        abortSignal: controller.signal,
      });
      if (codebase.results > 0) {
        addEntry({ role: 'info', text: `codebase: attached ${codebase.results} chunks` });
      }
      if (codebase.note) {
        addEntry({ role: 'info', text: `codebase: ${codebase.note}` });
      }
      const expanded = await expandFileReferences(codebase.text, cwd);
      if (expanded.files.length > 0) {
        addEntry({ role: 'info', text: `attached ${expanded.files.join(', ')}` });
      }
      if (expanded.missing.length > 0) {
        addEntry({ role: 'info', text: `not found: ${expanded.missing.join(', ')}` });
      }
      pending = [...historyRef.current, { role: 'user', content: expanded.text }];
      const compressed = await maybeCompress(pending, {
        maxTokens: maxContext,
        summarize: createHistorySummarizer(registry, model, controller.signal),
      });
      pending = compressed.messages;
      if (compressed.compressed) {
        addEntry({ role: 'info', text: 'context compressed: older history summarized' });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        addEntry({ role: 'info', text: `context preparation skipped: ${(err as Error).message}` });
      }
    }

    if (controller.signal.aborted) {
      addEntry({ role: 'info', text: '(cancelled)' });
      setStreaming('');
      setBusy(false);
      abortRef.current = null;
      return;
    }

    const ctx: ToolContext = { cwd: process.cwd(), askPermission, log: () => {} };
    const defaultTools = embedder
      ? [...createDefaultTools(), ...createRagTools(embedder)]
      : createDefaultTools();
    const tools = buildToolSet(defaultTools, ctx, permissionMode, rules);

    let acc = '';
    let sawToolCall = false;
    const flushText = () => {
      if (!acc.trim()) return;
      addEntry({ role: 'assistant', text: acc });
      acc = '';
      setStreaming('');
    };

    try {
      const result = await runAgent(
        {
          model,
          system,
          tools,
          messages: pending,
          abortSignal: controller.signal,
          onEvent: (event) => {
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
            }
          },
        },
        registry,
      );

      historyRef.current = result.messages;
      store.setTitleIfEmpty(session.id, typed);
      store.saveMessages(session.id, result.messages);
      store.addUsage(session.id, {
        totalTokens: result.usage.totalTokens,
        costUsd: result.costUsd,
      });
      const updated = store.get(session.id);
      if (updated) setSession(updated);
      const meta = `${result.usage.totalTokens} tokens · ${formatCost(result.costUsd)}`;
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
