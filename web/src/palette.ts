export interface PaletteMatch {
  /** Higher is a better hit; used only to order results. */
  score: number;
  /** Half-open [start, end) index ranges of the label that the needle matched. */
  ranges: Array<[number, number]>;
}

const SEPARATORS = ' /\\-_.,:;()[]{}';

function boundaryBonus(index: number, haystack: string): number {
  if (index === 0) return 24;
  const previous = haystack[index - 1];
  if (previous === undefined) return 0;
  if (SEPARATORS.includes(previous)) return 16;
  const current = haystack[index];
  if (
    current !== undefined &&
    current === current.toUpperCase() &&
    previous === previous.toLowerCase()
  ) {
    return 12;
  }
  return 0;
}

/**
 * Subsequence match scoring word starts and unbroken runs above scattered hits,
 * so "om" finds "Open folder…" and "ns" finds "New session" ahead of noise.
 */
export function fuzzyMatch(haystack: string, needle: string): PaletteMatch | null {
  const text = haystack.toLowerCase();
  const want = needle.toLowerCase().replace(/\s+/g, '');
  if (want === '') return { score: 0, ranges: [] };

  const ranges: Array<[number, number]> = [];
  let cursor = -1;
  let score = 0;

  for (const char of want) {
    const found = text.indexOf(char, cursor + 1);
    if (found === -1) return null;
    score += boundaryBonus(found, text);
    score -= found - (cursor + 1);
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) ranges[ranges.length - 1] = [last[0], found + 1];
    else ranges.push([found, found + 1]);
    cursor = found;
  }

  score -= text.length / 40;
  if (text === want) score += 40;
  return { score, ranges };
}

export interface Ranked<T> {
  action: T;
  score: number;
  /** Ranges measured against the action's label, for highlighting. */
  ranges: Array<[number, number]>;
}

/**
 * Each field is searched on its own: the needle has to fit inside one of them,
 * so keyword aliases widen what a query can reach without letting stray letters
 * chain across field boundaries. Highlight ranges come from the label only.
 */
export function rankActions<T>(
  actions: T[],
  query: string,
  fields: (action: T) => string[],
): Array<Ranked<T>> {
  const needle = query.trim();
  if (needle === '') return actions.map((action) => ({ action, score: 0, ranges: [] }));

  const ranked: Array<Ranked<T>> = [];
  for (const action of actions) {
    const fieldsForAction = fields(action);
    let best: PaletteMatch | null = null;
    let onLabel = false;
    for (let position = 0; position < fieldsForAction.length; position++) {
      const field = fieldsForAction[position] ?? '';
      const hit = field === '' ? null : fuzzyMatch(field, needle);
      if (hit && (best === null || hit.score > best.score)) {
        best = hit;
        onLabel = position === 0;
      }
    }
    if (best) ranked.push({ action, score: best.score, ranges: onLabel ? best.ranges : [] });
  }
  return ranked.sort((a, b) => b.score - a.score);
}
