import type { ModelMessage } from 'ai';
import { Box, Text, useApp, useInput } from 'ink';
import { useRef, useState } from 'react';
import { runAgent } from '../core/agent.js';
import { formatCost } from '../core/cost.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';

interface TranscriptEntry {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  meta?: string;
}

export interface AppProps {
  registry: ProviderRegistry;
  model: ModelSpec;
}

export function App({ registry, model }: AppProps) {
  const { exit } = useApp();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<ModelMessage[]>([]);
  const nextId = useRef(0);

  const addEntry = (entry: Omit<TranscriptEntry, 'id'>) => {
    const id = nextId.current++;
    setEntries((prev) => [...prev, { ...entry, id }]);
  };

  async function submit() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    if (prompt === '/exit' || prompt === '/quit') {
      exit();
      return;
    }

    setInput('');
    setBusy(true);
    addEntry({ role: 'user', text: prompt });
    historyRef.current = [...historyRef.current, { role: 'user', content: prompt }];

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      const result = await runAgent(
        {
          model,
          messages: historyRef.current,
          abortSignal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'text-delta') {
              acc += event.delta;
              setStreaming(acc);
            }
          },
        },
        registry,
      );
      historyRef.current = [...historyRef.current, { role: 'assistant', content: result.text }];
      addEntry({
        role: 'assistant',
        text: result.text || '(no output)',
        meta: `${result.usage.totalTokens} tokens · ${formatCost(result.costUsd)}`,
      });
    } catch (err) {
      addEntry({ role: 'assistant', text: `[error] ${(err as Error).message}` });
    } finally {
      setStreaming('');
      setBusy(false);
      abortRef.current = null;
    }
  }

  useInput((chunk, key) => {
    if (key.ctrl && chunk === 'c') {
      if (busy && abortRef.current) {
        abortRef.current.abort();
        return;
      }
      exit();
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
          {model.provider}/{model.modelId} · Enter to send · /exit or Ctrl+C to quit
        </Text>
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {entries.map((entry) => (
          <Box key={entry.id} flexDirection="column" marginBottom={1}>
            <Text bold color={entry.role === 'user' ? 'green' : 'magenta'}>
              {entry.role === 'user' ? '› you' : '‹ cake'}
            </Text>
            <Text>{entry.text}</Text>
            {entry.meta ? <Text dimColor>{entry.meta}</Text> : null}
          </Box>
        ))}

        {busy && streaming ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="magenta">
              ‹ cake
            </Text>
            <Text>{streaming}</Text>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text bold color="green">
          {'> '}
        </Text>
        <Text>{input}</Text>
        {busy ? <Text dimColor>{' (streaming… Ctrl+C to cancel)'}</Text> : null}
      </Box>
    </Box>
  );
}
