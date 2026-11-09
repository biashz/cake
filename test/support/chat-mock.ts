import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A Messages endpoint the controller can be pointed at, with the responses held
 * back until the test releases them. That hold is the point: a claim like "two
 * sessions run at once" can only be observed while both requests are waiting.
 */

export interface ChatRequest {
  /** The last user text, so a test can tell which session asked. */
  prompt: string;
  model: string;
  messages: number;
}

export interface ChatMock {
  url: string;
  requests: ChatRequest[];
  /** Requests the client is still waiting on. */
  pending(): number;
  /** Resolves once `count` requests have arrived. */
  arrived(count: number): Promise<ChatRequest[]>;
  /** Answer the oldest waiting request with this text, as the provider would. */
  reply(text: string): void;
  /**
   * Answer the oldest waiting request by asking for a tool, as the provider
   * would: the client runs it and comes back with the result, so the test
   * answers that second request with `reply` to end the turn.
   */
  replyTool(name: string, input: Json): void;
  /** Answer the waiting request that asked this, whatever order it arrived in. */
  replyTo(ask: string, text: string): void;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

/** A response the mock is holding back until the test releases it. */
interface Gate {
  /** The prompt this answer belongs to, so a test can pick it out. */
  ask: string;
  answer(text: string): void;
  /** Answer by asking for a tool instead, which sends the client away again. */
  tool(name: string, input: Json): void;
}

function lastUserText(body: Json): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const last = messages[messages.length - 1];
  const content = last?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const part = raw as { type?: string; text?: string };
      return part.type === 'text' ? (part.text ?? '') : '';
    })
    .join('');
}

function messageStart(model: string): Json {
  return {
    type: 'message_start',
    message: {
      id: 'mock_turn',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: { input_tokens: 11, output_tokens: 1 },
    },
  };
}

function stream(text: string, model: string): string {
  const events: [string, Json][] = [
    ['message_start', messageStart(model)],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** The same shape with one tool_use block, which is how the vendor asks for a call. */
function toolStream(name: string, input: Json, model: string): string {
  const events: [string, Json][] = [
    ['message_start', messageStart(model)],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'mock_tool_1', name, input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

export async function startChatMock(): Promise<ChatMock> {
  const requests: ChatRequest[] = [];
  const held: Gate[] = [];
  const waiters: (() => void)[] = [];

  const server: Server = createServer((request, response) => {
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
      const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-4-5';
      const history = Array.isArray(body.messages) ? body.messages.length : 0;
      const prompt = lastUserText(body);
      requests.push({ prompt, model, messages: history });

      // Hold the answer: the test decides when, and in what order, requests finish.
      let answered = false;
      const send = (body: string) => {
        if (answered) return;
        answered = true;
        if (response.destroyed) return;
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.end(body);
      };
      const gate: Gate = {
        ask: prompt,
        answer: (text) => send(stream(text, model)),
        tool: (name, input) => send(toolStream(name, input, model)),
      };
      held.push(gate);
      waiters.shift()?.();

      // A client that hung up is not a request still waiting for an answer.
      response.on('close', () => {
        if (answered) return;
        const at = held.indexOf(gate);
        if (at >= 0) held.splice(at, 1);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    pending: () => held.length,
    async arrived(count) {
      while (requests.length < count) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          // A request may have landed while the waiter was being registered.
          if (requests.length >= count) resolve();
        });
      }
      return requests;
    },
    reply(text) {
      const next = held.shift();
      if (!next) throw new Error('No waiting request to answer');
      next.answer(text);
    },
    replyTool(name, input) {
      const next = held.shift();
      if (!next) throw new Error('No waiting request to answer');
      next.tool(name, input);
    },
    replyTo(ask, text) {
      const at = held.findIndex((gate) => gate.ask.includes(ask));
      if (at < 0) throw new Error(`No waiting request that asked: ${ask}`);
      held.splice(at, 1)[0]?.answer(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Answer anything still held so the SDK's calls settle before the server goes away.
        while (held.length > 0) held.shift()?.answer('');
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
