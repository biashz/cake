import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  hasToolResult: boolean;
  toolCount: number;
  /** Picture blocks on the wire: proof an attached image left the app. */
  imageParts: number;
}

export interface MockAnthropicOptions {
  /**
   * Answer a prompt with this plain text instead of the usual write-tool flow.
   * Returning null leaves the turn to the tool path.
   */
  plainText?: (prompt: string) => string | null;
  /**
   * Hold every plain-text answer until this many requests are open at once.
   * An app that runs one turn at a time never fills the queue, so a spec that
   * needs two turns in flight fails out loud rather than passing on the first.
   */
  holdUntil?: number;
}

export interface MockAnthropic {
  url: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

function messagesOf(body: Json): Json[] {
  return Array.isArray(body.messages) ? (body.messages as Json[]) : [];
}

function hasToolResult(messages: Json[]): boolean {
  return messages.some((message) => {
    const content = message.content;
    return Array.isArray(content) && content.some((part) => (part as Json).type === 'tool_result');
  });
}

/** Anthropic's wire shape for a picture: `{type:'image', source:{type:'base64', data}}`. */
function imageParts(messages: Json[]): number {
  let found = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const part = raw as Json;
      const source = part.source as Json | undefined;
      if (part.type === 'image' && source?.type === 'base64' && typeof source.data === 'string')
        found += 1;
    }
  }
  return found;
}

/** What the model was last asked, as one string. */
function lastUserText(messages: Json[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((raw) => ((raw as Json).type === 'text' ? String((raw as Json).text ?? '') : ''))
      .join(' ');
  }
  return '';
}

function textResponse(model: string, text: string) {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_e2e',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 6 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
}

function writeToolResponse(model: string) {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_e2e_tool',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_e2e', name: 'write', input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ path: 'hello.txt', content: 'hello from e2e\n' }),
        },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 24 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
}

/**
 * Minimal Anthropic Messages streaming endpoint. The first request (no tool result
 * yet) asks for a `write` tool call; after the agent reports the result, it answers
 * with plain text. No test-only hooks in the app: the real SDK path is exercised.
 * `plainText` swaps that for a fixed answer, and `holdUntil` withholds those
 * answers until the app itself proves it can hold several turns open.
 */
export async function startMockAnthropic(
  options: MockAnthropicOptions = {},
): Promise<MockAnthropic> {
  const requests: MockRequest[] = [];
  const gate = options.holdUntil ?? 0;
  const waiting: Array<() => void> = [];

  /** Answer everything queued once enough turns are open at the same time. */
  function flush(): void {
    for (const send of waiting.splice(0)) send();
  }

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body: Json = {};
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        body = {};
      }

      // Same port, OpenAI shape: lets a spec give cake embeddings without a real key.
      if (String(request.url ?? '').endsWith('/embeddings')) {
        const input = body.input;
        const texts = Array.isArray(input) ? input.map(String) : [String(input ?? '')];
        const data = texts.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: 8 }, (_, slot) => (text.charCodeAt(slot) || slot) / 64),
        }));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', model: 'text-embedding-3-small', data }));
        return;
      }

      const messages = messagesOf(body);
      const toolResult = hasToolResult(messages);
      requests.push({
        hasToolResult: toolResult,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        imageParts: imageParts(messages),
      });

      const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-4-5';
      const plain = options.plainText?.(lastUserText(messages)) ?? null;
      const events =
        plain !== null
          ? textResponse(model, plain)
          : toolResult
            ? textResponse(model, 'Created hello.txt.')
            : writeToolResponse(model);

      const send = () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for (const [event, data] of events) {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        response.end();
      };

      if (plain === null || gate <= 0) send();
      else {
        waiting.push(send);
        // A tool turn answering is no proof of concurrency, so only a held
        // answer counts toward the gate.
        if (waiting.length >= gate) flush();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
