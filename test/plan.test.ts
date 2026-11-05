import { describe, expect, it } from 'vitest';
import { planProgress } from '../src/core/plan.js';

describe('planProgress', () => {
  it('counts from the list itself, so a readout cannot drift from it', () => {
    expect(
      planProgress([
        { id: 1, subject: 'a', status: 'completed' },
        { id: 2, subject: 'b', status: 'in_progress' },
        { id: 3, subject: 'c', status: 'pending' },
        { id: 4, subject: 'd', status: 'completed' },
      ]),
    ).toEqual({ done: 2, active: 1, total: 4 });
  });

  it('reports an empty plan as no progress', () => {
    expect(planProgress([])).toEqual({ done: 0, active: 0, total: 0 });
  });
});
