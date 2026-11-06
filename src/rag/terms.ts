const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'function',
  'const',
  'return',
  'where',
  'what',
  'how',
  'does',
  'class',
  'import',
  'export',
  'let',
  'var',
  'async',
  'await',
]);

/** Split identifiers on camelCase/snake_case and drop noise tokens. */
export function tokenize(text: string): string[] {
  const words = text.match(/[A-Za-z0-9_\u4e00-\u9fff]+/g) ?? [];
  const tokens: string[] = [];
  for (const word of words) {
    for (const part of word.split(/_+/)) {
      for (const piece of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
        const token = piece.toLowerCase();
        if (token.length >= 2 && !STOPWORDS.has(token)) tokens.push(token);
      }
    }
  }
  return tokens;
}

/**
 * What the FTS row indexes: the same tokens the scorer compares, space-joined.
 * Feeding raw source to FTS5 would index `alphaHandler` as one term and miss a
 * query for `alpha`, so the split has to happen before it is stored.
 */
export function toTerms(path: string, text: string): string {
  return tokenize(`${path}\n${text}`).join(' ');
}
