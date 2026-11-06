import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  hasToolResult: boolean;
  toolCount: number;
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
 */
export async function startMockAnthropic(): Promise<MockAnthropic> {
  const requests: MockRequest[] = [];

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
      });

      const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-4-5';
      const events = toolResult
        ? textResponse(model, 'Created hello.txt.')
        : writeToolResponse(model);

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const [event, data] of events) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      response.end();
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
