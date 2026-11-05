export type EntryRole = 'user' | 'assistant' | 'tool' | 'info' | 'error';

export interface ToolInfo {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  status: 'running' | 'done' | 'error';
}

export interface Entry {
  id: number;
  role: EntryRole;
  text?: string;
  meta?: string;
  tool?: ToolInfo;
}

export function previewValue(value: unknown, max = 160): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const line = (raw ?? '').split('\n').find((item) => item.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** One-line target for a tool call: path, command, prompt, query, or fallback JSON. */
export function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return previewValue(input);
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'command', 'prompt', 'query', 'pattern', 'type']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return previewValue(value);
  }
  return previewValue(input);
}

export function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null) {
    const record = output as Record<string, unknown>;
    if (typeof record.value === 'string') return record.value;
  }
  return JSON.stringify(output ?? '', null, 2);
}

/** Best-effort rendering of stored ModelMessage history back into transcript entries. */
export function entriesFromMessages(messages: unknown[]): Entry[] {
  let entries: Entry[] = [];
  let nextId = 0;

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role === 'user' || message.role === 'system') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => (part as { text?: string }).text ?? '').join('')
            : '';
      if (text.trim()) entries.push({ id: nextId++, role: 'user', text });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: String(message.content ?? '') }];
      for (const rawPart of parts) {
        const part = rawPart as {
          type?: string;
          text?: string;
          toolName?: string;
          input?: unknown;
        };
        if (part.type === 'text' && part.text?.trim()) {
          entries.push({ id: nextId++, role: 'assistant', text: part.text });
        } else if (part.type === 'tool-call') {
          entries.push({
            id: nextId++,
            role: 'tool',
            tool: {
              name: part.toolName ?? 'tool',
              input: part.input,
              status: 'running',
            },
          });
        }
      }
      continue;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = rawPart as { type?: string; toolName?: string; output?: unknown };
        if (part.type !== 'tool-result') continue;
        entries = attachToolResult(
          entries,
          part.toolName ?? 'tool',
          stringifyOutput(part.output),
          'done',
        );
      }
    }
  }
  return entries;
}

export function attachToolResult(
  entries: Entry[],
  toolName: string,
  output: unknown,
  status: 'done' | 'error',
): Entry[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.role === 'tool' &&
      entry.tool?.name === toolName &&
      entry.tool.status === 'running'
    ) {
      return entries.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              tool: {
                ...item.tool,
                status,
                ...(status === 'error' ? { error: String(output) } : { output: output }),
              } as ToolInfo,
            }
          : item,
      );
    }
  }
  return entries;
}
