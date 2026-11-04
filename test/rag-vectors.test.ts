import { describe, expect, it } from 'vitest';
import { normalizeVector } from '../src/rag/index-store.js';

describe('index store vectors', () => {
  it('normalizes vectors to unit length', () => {
    const normalized = normalizeVector(Float32Array.from([3, 4]));
    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
  });

  it('handles zero vectors without dividing by zero', () => {
    const normalized = normalizeVector(Float32Array.from([0, 0]));
    expect([...normalized]).toEqual([0, 0]);
  });
});
