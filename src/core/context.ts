import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { generateText, type ModelMessage } from 'ai';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { SYSTEM_PROMPT } from './prompt.js';

const MAX_INSTRUCTIONS_BYTES = 32_000;
const DEFAULT_KEEP_TURNS = 4;
const DEFAULT_THRESHOLD = 0.75;

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** AGENTS.md files from the filesystem root down to `cwd` (outermost first). */
export async function findAgentsFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, 'AGENTS.md');
    if (await isFile(candidate)) found.unshift(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export interface ProjectSection {
  path: string;
  text: string;
}

/** AGENTS.md files as label/content sections, outermost first, capped in total. */
export async function loadProjectSections(cwd: string): Promise<ProjectSection[]> {
  const files = await findAgentsFiles(cwd);
  const sections: ProjectSection[] = [];
  let budget = MAX_INSTRUCTIONS_BYTES;
  for (const file of files) {
    const content = (await readFile(file, 'utf8')).trim();
    if (!content) continue;
    const text = content.slice(0, budget);
    if (!text) break;
    sections.push({ path: relativeLabel(file, cwd), text });
    budget -= text.length;
  }
  return sections;
}

function relativeLabel(file: string, cwd: string): string {
  return path.relative(cwd, file) || 'AGENTS.md';
}

export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  const sections = await loadProjectSections(cwd);
  if (sections.length === 0) return undefined;
  return sections.map((section) => `## ${section.path}\n${section.text}`).join('\n\n');
}

export interface SystemPromptOptions {
  cwd: string;
  projectInstructions?: string;
}

export function buildSystemPrompt({ cwd, projectInstructions }: SystemPromptOptions): string {
  const parts = [SYSTEM_PROMPT, `Workspace: ${cwd}\nPlatform: ${process.platform}`];
  if (projectInstructions) {
    parts.push(`# Project instructions (AGENTS.md)\n${projectInstructions}`);
  }
  return parts.join('\n\n');
}

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Tokens for plain text on the same ~4 chars/token basis as estimateTokens. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  return String(content ?? '');
}

export function formatTranscript(messages: ModelMessage[], maxChars = 120_000): string {
  const lines = messages.map((message) => {
    const text = contentText(message.content);
    const clipped = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    return `${message.role}: ${clipped}`;
  });
  return lines.join('\n\n').slice(0, maxChars);
}

export interface CompressionOptions {
  maxTokens: number;
  keepTurns?: number;
  threshold?: number;
  summarize: (transcript: string) => Promise<string>;
}

export interface CompressionResult {
  messages: ModelMessage[];
  compressed: boolean;
}

/**
 * Replace all but the last `keepTurns` user turns with a summary when the
 * history exceeds `threshold` of the token budget. Cutting at a user-message
 * boundary keeps assistant/tool pairs intact.
 */
export async function maybeCompress(
  messages: ModelMessage[],
  options: CompressionOptions,
): Promise<CompressionResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;
  if (estimateTokens(messages) <= options.maxTokens * threshold) {
    return { messages, compressed: false };
  }

  const userIndices = messages.flatMap((message, index) =>
    message.role === 'user' ? [index] : [],
  );
  if (userIndices.length <= keepTurns) return { messages, compressed: false };

  const cut = userIndices[userIndices.length - keepTurns] as number;
  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  const summary = (await options.summarize(formatTranscript(older))).trim();
  if (!summary) return { messages, compressed: false };

  const summaryMessage: ModelMessage = {
    role: 'user',
    content: `[Earlier conversation summary]\n${summary}`,
  };
  return { messages: [summaryMessage, ...recent], compressed: true };
}

export function createHistorySummarizer(
  registry: ProviderRegistry,
  model: ModelSpec,
  abortSignal?: AbortSignal,
): (transcript: string) => Promise<string> {
  return async (transcript) => {
    const { text } = await generateText({
      model: registry.resolveModel(model),
      system:
        'You compress conversation history for a coding agent. Preserve decisions, file paths, commands, errors, and open tasks. Reply with a compact bullet summary only.',
      prompt: transcript,
      abortSignal,
      maxOutputTokens: 800,
    });
    return text;
  };
}
