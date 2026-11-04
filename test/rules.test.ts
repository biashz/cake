import { describe, expect, it } from 'vitest';
import { EMPTY_RULES, evaluateRules, globToRegExp, parseRule } from '../src/permissions/rules.js';

describe('parseRule', () => {
  it('parses tool-only and tool(pattern) rules', () => {
    expect(parseRule('read')).toEqual({ tool: 'read' });
    expect(parseRule('bash(npm test*)')).toEqual({ tool: 'bash', pattern: 'npm test*' });
    expect(parseRule('  write(src/**)  ')).toEqual({ tool: 'write', pattern: 'src/**' });
  });

  it('rejects malformed rules', () => {
    expect(parseRule('')).toBeNull();
    expect(parseRule('bad rule')).toBeNull();
    expect(parseRule('bash(')).toBeNull();
  });
});

describe('globToRegExp', () => {
  it('anchors and translates wildcards', () => {
    expect(globToRegExp('npm test*').test('npm test --watch')).toBe(true);
    expect(globToRegExp('npm test*').test('npm run test')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('?.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('?.ts').test('ab.ts')).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('matches a tool-only rule', () => {
    expect(evaluateRules({ allow: ['write'], deny: [] }, 'write', 'a.ts')).toBe('allow');
    expect(evaluateRules({ allow: ['write'], deny: [] }, 'edit', 'a.ts')).toBe('neutral');
  });

  it('matches a pattern rule against the target', () => {
    const rules = { allow: ['bash(npm test*)'], deny: [] };
    expect(evaluateRules(rules, 'bash', 'npm test --run')).toBe('allow');
    expect(evaluateRules(rules, 'bash', 'npm run build')).toBe('neutral');
  });

  it('lets deny win over allow', () => {
    const rules = { allow: ['bash(*)'], deny: ['bash(rm *)'] };
    expect(evaluateRules(rules, 'bash', 'rm -rf build')).toBe('deny');
    expect(evaluateRules(rules, 'bash', 'npm test')).toBe('allow');
  });

  it('normalizes Windows path separators', () => {
    const rules = { allow: ['write(src/**)'], deny: [] };
    expect(evaluateRules(rules, 'write', 'src\\lib\\a.ts')).toBe('allow');
  });

  it('returns neutral for empty rules', () => {
    expect(evaluateRules(EMPTY_RULES, 'bash', 'anything')).toBe('neutral');
  });
});
