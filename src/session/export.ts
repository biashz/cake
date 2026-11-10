import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { spendLabel } from '../core/cost.js';
import { storedImage } from '../core/images.js';
import { TASK_MARKS } from '../core/plan.js';
import type { TaskItem } from '../tools/types.js';
import type { SessionMeta, SessionStore } from './store.js';

export interface SessionDocument {
  meta: SessionMeta;
  messages: ModelMessage[];
  plan: TaskItem[];
}

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

/** Where the export writes the pictures a session was sent with, relative to its own file. */
export const ASSET_FOLDER = 'assets';

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * A picture is named for what it holds, so the same bytes pasted into two turns
 * link one file rather than writing a copy per turn. Nothing from the session
 * reaches the name, so a link cannot point out of the export folder.
 */
function assetName(mediaType: string, base64: string): string {
  return `image-${createHash('sha256').update(base64).digest('hex').slice(0, 12)}${IMAGE_EXT[mediaType] ?? '.img'}`;
}

function imagesIn(content: unknown): { name: string; base64: string }[] {
  if (!Array.isArray(content)) return [];
  const found: { name: string; base64: string }[] = [];
  for (const part of content) {
    const image = storedImage(part);
    if (image) found.push({ name: assetName(image.mediaType, image.base64), base64: image.base64 });
  }
  return found;
}

/** One file the export writes next to its own Markdown. */
export interface SessionAsset {
  name: string;
  bytes: Buffer;
}

/** What a session renders to: the Markdown and every picture that Markdown links. */
export interface SessionRender {
  markdown: string;
  assets: SessionAsset[];
}

/**
 * The stored transcript as Markdown, with the pictures it links: what the model
 * saw, in the order it saw it. A `@file` mention is stored as the expanded text,
 * and that is what lands here too — the export is the conversation, not what was typed.
 */
export function renderSession(document: SessionDocument): SessionRender {
  const { meta, messages, plan } = document;
  const out: string[] = [];
  // Name to bytes, so a picture two turns repeat is written once and linked twice.
  const assets = new Map<string, string>();

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
    for (const item of plan) out.push(`- ${TASK_MARKS[item.status]} ${item.subject}`);
  }

  let turn = 0;
  for (const message of messages) {
    const role = message.role as string;
    if (role === 'user') {
      const body = text(message.content).trim();
      const pictures = imagesIn(message.content);
      if (!body && pictures.length === 0) continue;
      turn += 1;
      const title =
        body !== ''
          ? firstLine(body)
          : `${pictures.length} ${pictures.length === 1 ? 'image' : 'images'}`;
      out.push('', `## ${turn}. ${title}`, '');
      if (body) out.push(body, '');
      for (const picture of pictures) {
        if (!assets.has(picture.name)) assets.set(picture.name, picture.base64);
        out.push(`![${picture.name}](${ASSET_FOLDER}/${picture.name})`, '');
      }
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

  return {
    markdown: `${out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()}\n`,
    assets: [...assets].map(([name, base64]) => ({
      name,
      bytes: Buffer.from(base64, 'base64'),
    })),
  };
}

/** The transcript on its own, for a reader who has nowhere to write pictures. */
export function sessionMarkdown(document: SessionDocument): string {
  return renderSession(document).markdown;
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

/** What one export wrote: the Markdown, and the pictures it links beside it. */
export interface ExportResult {
  file: string;
  /** How many picture files were written next to the Markdown. */
  pictures: number;
  /** The folder holding them — only when there was something to hold. */
  assetFolder?: string;
}

/**
 * Write one session as Markdown, with every picture it links written next to it.
 * Re-exporting the same session replaces its own files, because the name carries
 * the session id.
 */
export function exportSessionMarkdown(
  store: SessionStore,
  sessionId: string,
  file?: string,
): ExportResult {
  const meta = store.get(sessionId);
  if (!meta) throw new Error(`Unknown session "${sessionId}"`);
  const rendered = renderSession({
    meta,
    messages: store.messages(sessionId),
    plan: store.plan(sessionId),
  });
  const target = file
    ? // A relative path is relative to the workspace the session belongs to,
      // not to whatever folder the program happened to start in.
      path.resolve(meta.cwd, file)
    : path.join(meta.cwd, '.cake', 'exports', exportFileName(meta));
  const folder = path.dirname(target);
  mkdirSync(folder, { recursive: true });
  let assetFolder: string | undefined;
  if (rendered.assets.length > 0) {
    assetFolder = path.join(folder, ASSET_FOLDER);
    mkdirSync(assetFolder, { recursive: true });
    for (const asset of rendered.assets) {
      writeFileSync(path.join(assetFolder, asset.name), asset.bytes);
    }
  }
  writeFileSync(target, rendered.markdown, 'utf8');
  return { file: target, pictures: rendered.assets.length, assetFolder };
}
