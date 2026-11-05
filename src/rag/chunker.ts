import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';

const MAX_CHUNK_LINES = 120;
const MAX_CHUNK_CHARS = 8_000;
const WINDOW_LINES = 80;
const WINDOW_OVERLAP = 10;

export interface SourceChunk {
  path: string;
  startLine: number;
  endLine: number;
  kind: string;
  text: string;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.jsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'cpp',
  '.h': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'c-sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.css': 'css',
  '.ini': 'ini',
};

const CHUNK_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'function_item',
  'generator_function_declaration',
  'method_definition',
  'method_declaration',
  'class_declaration',
  'class_definition',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'struct_item',
  'trait_item',
  'impl_item',
  'mod_item',
  'lexical_declaration',
  'variable_declaration',
]);

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Promise<Parser>>();

function wasmDirectory(): string {
  const override = process.env.CAKE_WASM_DIR;
  if (override) return override;
  const pkg = createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm/package.json');
  return path.join(path.dirname(pkg), 'wasm');
}

function initParser(): Promise<void> {
  const override = process.env.CAKE_WASM_DIR;
  return Parser.init(
    override ? { locateFile: (name: string) => path.join(override, name) } : undefined,
  );
}

function loadLanguage(name: string): Promise<Language> {
  const cached = languageCache.get(name);
  if (cached) return cached;
  initPromise ??= initParser();
  const loaded = initPromise.then(() =>
    Language.load(path.join(wasmDirectory(), `tree-sitter-${name}.wasm`)),
  );
  languageCache.set(name, loaded);
  return loaded;
}

async function parserFor(name: string): Promise<Parser> {
  const cached = parserCache.get(name);
  if (cached) return cached;
  const created = loadLanguage(name).then((language) => {
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  });
  parserCache.set(name, created);
  return created;
}

export function languageForFile(filePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

export function supportedExtensions(): string[] {
  return Object.keys(LANGUAGE_BY_EXTENSION);
}

function lineEnd(node: SyntaxNode): number {
  return node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0);
}

function isChunkNode(node: SyntaxNode): boolean {
  if (!CHUNK_TYPES.has(node.type)) return false;
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    return node.text.includes('=>') || node.text.includes('function');
  }
  return true;
}

function makeChunk(
  filePath: string,
  lines: string[],
  startLine: number,
  endLine: number,
  kind: string,
): SourceChunk | undefined {
  const text = lines
    .slice(startLine - 1, endLine)
    .join('\n')
    .slice(0, MAX_CHUNK_CHARS)
    .trimEnd();
  if (text.trim().length < 20) return undefined;
  return { path: filePath, startLine, endLine, kind, text };
}

function lineWindows(
  filePath: string,
  lines: string[],
  from = 1,
  to = lines.length,
): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  for (let start = from; start <= to; start += WINDOW_LINES - WINDOW_OVERLAP) {
    const end = Math.min(to, start + WINDOW_LINES - 1);
    const chunk = makeChunk(filePath, lines, start, end, 'lines');
    if (chunk) chunks.push(chunk);
    if (end >= to) break;
  }
  return chunks;
}

function collect(root: SyntaxNode, filePath: string, lines: string[]): SourceChunk[] {
  const chunks: SourceChunk[] = [];

  const visit = (node: SyntaxNode): void => {
    if (isChunkNode(node)) {
      const start = node.startPosition.row + 1;
      const end = Math.min(lines.length, lineEnd(node));
      if (end - start + 1 <= MAX_CHUNK_LINES) {
        const chunk = makeChunk(filePath, lines, start, end, node.type);
        if (chunk) {
          chunks.push(chunk);
          return;
        }
      }
      const before = chunks.length;
      for (const child of node.namedChildren) visit(child);
      if (chunks.length === before) {
        chunks.push(...lineWindows(filePath, lines, start, end));
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(root);
  return chunks;
}

/**
 * Split a source file into AST-aware chunks (functions, classes, methods), with
 * line-window fallback for unsupported languages, parse failures, or files that
 * contain no declarations.
 */
export async function chunkSource(filePath: string, content: string): Promise<SourceChunk[]> {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length === 0) return [];

  const language = languageForFile(filePath);
  if (language) {
    try {
      const parser = await parserFor(language);
      const tree = parser.parse(normalized);
      if (tree) {
        const chunks = collect(tree.rootNode, filePath, lines);
        if (chunks.length > 0) return chunks;
      }
    } catch {
      // fall through to line windows
    }
  }
  return lineWindows(filePath, lines);
}
