import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { spendLabel } from '../core/cost.js';
import type { TaskItem } from '../tools/types.js';
import type { SessionMeta, SessionStore } from './store.js';

export interface SessionDocument {
  meta: SessionMeta;
  messages: ModelMessage[];
  plan: TaskItem[];
}

const MARKS: Record<TaskItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

/** `2026-11-06 14:03`, UTC — a file has to mean the same thing on every machine. */
function stamp(value: number): string {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const part = raw as { type?: string; text?: string };
      return part.type === 'text' ? (part.text ?? '') : '';
    })
    .join('');
}

/**
 * A tool result is stored as the SDK's envelope; the export shows the payload it
 * carries, which is what the transcript shows.
 */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null) {
    const value = (output as { value?: unknown }).value;
    if (typeof value === 'string') return value;
    if (value !== undefined) return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(output ?? null, null, 2);
}

/** A fence long enough to survive backticks already inside the payload. */
function fence(value: string, lang = ''): string {
  const longest = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${value}\n${ticks}`;
}

function json(value: unknown): string {
  return fence(JSON.stringify(value ?? null, null, 2), 'json');
}

function firstLine(value: string, max = 70): string {
  const line = value.split('\n').find((item) => item.trim() !== '') ?? '';
  const flat = line.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The stored transcript as Markdown: what the model saw, in the order it saw it.
 * A `@file` mention is stored as the expanded text, and that is what lands here
 * too — the export is the conversation, not what was typed.
 */
export function sessionMarkdown(document: SessionDocument): string {
  const { meta, messages, plan } = document;
  const out: string[] = [];

  out.push(`# ${meta.title || 'Untitled session'}`, '');
  out.push(`- session \`${meta.id.slice(0, 8)}\` · \`${meta.provider}/${meta.model}\``);
  out.push(`- workspace \`${meta.cwd}\``);
  out.push(
    `- ${meta.totalTokens.toLocaleString('en-US')} tokens · ${spendLabel(meta.costUsd, meta.unpricedTokens)}`,
  );
  out.push(
    `- started ${stamp(meta.createdAt)} · updated ${stamp(meta.updatedAt)}${
      meta.parentId ? ` · forked from \`${meta.parentId.slice(0, 8)}\`` : ''
    }`,
  );

  if (plan.length > 0) {
    out.push('', '## Plan', '');
    for (const item of plan) out.push(`- ${MARKS[item.status]} ${item.subject}`);
  }

  let turn = 0;
  for (const message of messages) {
    const role = message.role as string;
    if (role === 'user') {
      const body = text(message.content).trim();
      if (!body) continue;
      turn += 1;
      out.push('', `## ${turn}. ${firstLine(body)}`, '', body, '');
      continue;
    }

    const content = message.content as unknown;
    if (role === 'assistant') {
      const parts = Array.isArray(content)
        ? content
        : [{ type: 'text', text: String(content ?? '') }];
      for (const raw of parts) {
        const part = raw as { type?: string; text?: string; toolName?: string; input?: unknown };
        if (part.type === 'text' && part.text?.trim()) out.push(part.text.trim(), '');
        if (part.type === 'tool-call') {
          out.push(`**call \`${part.toolName ?? 'tool'}\`**`, '', json(part.input), '');
        }
      }
      continue;
    }

    if (role === 'tool' && Array.isArray(content)) {
      for (const raw of content) {
        const part = raw as { type?: string; toolName?: string; output?: unknown };
        if (part.type !== 'tool-result') continue;
        out.push(
          `**result \`${part.toolName ?? 'tool'}\`**`,
          '',
          fence(outputText(part.output)),
          '',
        );
      }
    }
  }

  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/** A file name safe to write anywhere; `..` and path separators cannot survive the slug. */
export function exportFileName(meta: SessionMeta): string {
  const folder =
    meta.cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? 'cake';
  const slug = folder.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40);
  return `${slug.replace(/^[.-]+/, '') || 'cake'}-${meta.id.slice(0, 8)}.md`;
}

/**
 * Write one session as Markdown and return the path. Re-exporting the same
 * session replaces its own file, because the name carries the session id.
 */
export function exportSessionMarkdown(
  store: SessionStore,
  sessionId: string,
  file?: string,
): string {
  const meta = store.get(sessionId);
  if (!meta) throw new Error(`Unknown session "${sessionId}"`);
  const markdown = sessionMarkdown({
    meta,
    messages: store.messages(sessionId),
    plan: store.plan(sessionId),
  });
  const target = file
    ? path.resolve(file)
    : path.join(meta.cwd, '.cake', 'exports', exportFileName(meta));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, markdown, 'utf8');
  return target;
}
