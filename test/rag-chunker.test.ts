import { describe, expect, it } from 'vitest';
import { chunkSource, languageForFile } from '../src/rag/chunker.js';

describe('tree-sitter chunker', () => {
  it('maps extensions to languages', () => {
    expect(languageForFile('src/a.ts')).toBe('typescript');
    expect(languageForFile('src/a.tsx')).toBe('tsx');
    expect(languageForFile('a.py')).toBe('python');
    expect(languageForFile('a.txt')).toBeUndefined();
  });

  it('splits TypeScript into function and class chunks', async () => {
    const source = [
      'export function greet(name: string): string {',
      '  return "hello " + name;',
      '}',
      '',
      'export class Greeter {',
      '  greet(name: string): string {',
      '    return name;',
      '  }',
      '}',
    ].join('\n');

    const chunks = await chunkSource('src/greet.ts', source);
    const fn = chunks.find((chunk) => chunk.kind === 'function_declaration');
    const cls = chunks.find((chunk) => chunk.kind === 'class_declaration');

    expect(fn?.text).toContain('export function greet');
    expect(fn?.startLine).toBe(1);
    expect(fn?.endLine).toBe(3);
    expect(cls?.text).toContain('export class Greeter');
    expect(cls?.endLine).toBe(9);
    expect(chunks.every((chunk) => chunk.path === 'src/greet.ts')).toBe(true);
  });

  it('extracts arrow functions declared with const', async () => {
    const source = ['const add = (a: number, b: number) => {', '  return a + b;', '};'].join('\n');

    const chunks = await chunkSource('add.ts', source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe('lexical_declaration');
    expect(chunks[0]?.text).toContain('const add');
  });

  it('falls back to line windows for unsupported or declaration-free files', async () => {
    const text = ['plain text file', 'with several lines', 'and no declarations'].join('\n');
    const chunks = await chunkSource('notes.txt', text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'lines', startLine: 1, endLine: 3 });

    const comments = ['// just a comment about the module', '// another comment line here'].join(
      '\n',
    );
    const tsChunks = await chunkSource('empty.ts', comments);
    expect(tsChunks).toHaveLength(1);
    expect(tsChunks[0]?.kind).toBe('lines');
  });
});
