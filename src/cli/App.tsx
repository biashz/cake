import type { ModelMessage } from 'ai';
import { Box, Text, useApp, useInput } from 'ink';
import { useRef, useState } from 'react';
import { runAgent } from '../core/agent.js';
import { formatCost } from '../core/cost.js';
import { SYSTEM_PROMPT } from '../core/prompt.js';
import type { PermissionRules } from '../permissions/rules.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
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
}

function preview(value: unknown, max = 160): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const line = (raw ?? '').split('\n').find((item) => item.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function App({ registry, model, permissionMode, rules }: AppProps) {
  const { exit } = useApp();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<ModelMessage[]>([]);
  const nextId = useRef(0);
  const approvalQueue = useRef<Promise<void>>(Promise.resolve());
  const abortedRef = useRef(false);

  const addEntry = (entry: Omit<TranscriptEntry, 'id'>) => {
    const id = nextId.current++;
    setEntries((prev) => [...prev, { ...entry, id }]);
  };

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
    const prompt = input.trim();
    if (!prompt || busy) return;
    if (prompt === '/exit' || prompt === '/quit') {
      exit();
      return;
    }

    setInput('');
    setBusy(true);
    abortedRef.current = false;
    addEntry({ role: 'user', text: prompt });
    historyRef.current = [...historyRef.current, { role: 'user', content: prompt }];

    const controller = new AbortController();
    abortRef.current = controller;
    const ctx: ToolContext = { cwd: process.cwd(), askPermission, log: () => {} };
    const tools = buildToolSet(createDefaultTools(), ctx, permissionMode, rules);

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
          system: SYSTEM_PROMPT,
          tools,
          messages: historyRef.current,
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
          {model.provider}/{model.modelId} · mode={permissionMode} · Enter to send · /exit or Ctrl+C
          to quit
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
