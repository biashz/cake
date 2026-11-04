import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  createHistorySummarizer,
  estimateTokens,
  findAgentsFiles,
  formatTranscript,
  loadProjectInstructions,
  maybeCompress,
} from '../src/core/context.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-context-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function fixture(rel: string, content: string): Promise<void> {
  const abs = path.join(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function turns(...ids: number[]): ModelMessage[] {
  return ids.flatMap((id) => [
    { role: 'user', content: `question ${id}` },
    { role: 'assistant', content: `answer ${id}` },
  ]);
}

describe('AGENTS.md discovery', () => {
  it('collects instructions from the workspace root down to cwd', async () => {
    await fixture('AGENTS.md', 'root rule');
    await fixture('sub/AGENTS.md', 'sub rule');
    const sub = path.join(cwd, 'sub');

    const files = await findAgentsFiles(sub);
    expect(files.at(-2)).toBe(path.join(cwd, 'AGENTS.md'));
    expect(files.at(-1)).toBe(path.join(sub, 'AGENTS.md'));

    const instructions = await loadProjectInstructions(sub);
    expect(instructions).toContain('root rule');
    expect(instructions).toContain('sub rule');

    const system = buildSystemPrompt({ cwd: sub, projectInstructions: instructions });
    expect(system).toContain(`Workspace: ${sub}`);
    expect(system).toContain('root rule');
  });

  it('returns undefined when no AGENTS.md exists', async () => {
    expect(await loadProjectInstructions(cwd)).toBeUndefined();
  });
});

describe('formatting and sizing', () => {
  it('estimates tokens from serialized size', () => {
    const small = estimateTokens([{ role: 'user', content: 'hi' }]);
    const large = estimateTokens([{ role: 'user', content: 'a'.repeat(4000) }]);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThanOrEqual(1000);
  });

  it('clips long messages in the transcript', () => {
    const out = formatTranscript([{ role: 'assistant', content: 'x'.repeat(3000) }]);
    expect(out.startsWith('assistant: ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(2100);
  });
});

describe('maybeCompress', () => {
  it('leaves history untouched below the threshold', async () => {
    const messages = turns(1);
    const result = await maybeCompress(messages, {
      maxTokens: 100_000,
      summarize: async () => {
        throw new Error('should not summarize');
      },
    });
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('summarizes older turns and keeps the last four user turns', async () => {
    const messages = turns(1, 2, 3, 4, 5, 6);
    const seen: string[] = [];
    const result = await maybeCompress(messages, {
      maxTokens: 10,
      summarize: async (transcript) => {
        seen.push(transcript);
        return '- summary';
      },
    });

    expect(result.compressed).toBe(true);
    expect(result.messages).toHaveLength(1 + 8);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: '[Earlier conversation summary]\n- summary',
    });
    expect(result.messages[1]?.content).toBe('question 3');
    expect(seen[0]).toContain('question 1');
    expect(seen[0]).not.toContain('question 3');
  });

  it('does not compress when there are too few user turns', async () => {
    const result = await maybeCompress(turns(1, 2), {
      maxTokens: 1,
      summarize: async () => 'summary',
    });
    expect(result.compressed).toBe(false);
  });

  it('keeps history when the summary is empty', async () => {
    const messages = turns(1, 2, 3, 4, 5);
    const result = await maybeCompress(messages, {
      maxTokens: 10,
      summarize: async () => '   ',
    });
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

describe('createHistorySummarizer', () => {
  it('asks the model for a compact summary', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: 'text', text: '- kept the bug fix decision' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 6, text: 6, reasoning: 0 },
          },
          warnings: [],
        },
      ],
    });
    const provider: ModelProvider = {
      id: 'anthropic',
      label: 'mock',
      defaultModelId: 'm',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      languageModel: () => model,
      capabilities: () => ({ toolCalling: true, vision: false, maxContext: 200_000 }),
    };
    const registry = new ProviderRegistry().register(provider, 'test-key');
    const summarize = createHistorySummarizer(registry, { provider: 'anthropic', modelId: 'm' });

    expect(await summarize('user: fix the bug')).toBe('- kept the bug fix decision');
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
