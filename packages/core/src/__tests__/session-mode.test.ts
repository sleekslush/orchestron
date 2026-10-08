import { describe, it, expect } from 'vitest';
import { resolveMovementSessionMode, resolveSessionMode } from '../conductor/session-mode.js';
import type { Program } from '../types/score.js';

describe('resolveSessionMode', () => {
  it('defaults to cumulative when no program is present', () => {
    expect(resolveSessionMode(undefined)).toEqual({
      mode: 'cumulative',
      deprecatedUsed: false,
      bothSet: false,
    });
  });

  it('defaults to cumulative when the key is omitted', () => {
    expect(resolveSessionMode({})).toEqual({
      mode: 'cumulative',
      deprecatedUsed: false,
      bothSet: false,
    });
  });

  it('honors an explicit reuseSession: true as cumulative', () => {
    expect(resolveSessionMode({ reuseSession: true })).toEqual({
      mode: 'cumulative',
      deprecatedUsed: false,
      bothSet: false,
    });
  });

  it('honors an explicit reuseSession: false as fresh', () => {
    expect(resolveSessionMode({ reuseSession: false })).toEqual({
      mode: 'fresh',
      deprecatedUsed: false,
      bothSet: false,
    });
  });

  it('honors a lone legacy persistSession key in both directions', () => {
    expect(resolveSessionMode({ persistSession: true })).toEqual({
      mode: 'cumulative',
      deprecatedUsed: true,
      bothSet: false,
    });
    expect(resolveSessionMode({ persistSession: false })).toEqual({
      mode: 'fresh',
      deprecatedUsed: true,
      bothSet: false,
    });
  });

  it('lets reuseSession win when both keys are present', () => {
    const both = resolveSessionMode({ reuseSession: true, persistSession: false } as Program);
    expect(both).toEqual({ mode: 'cumulative', deprecatedUsed: true, bothSet: true });

    const bothFalse = resolveSessionMode({ reuseSession: false, persistSession: true } as Program);
    expect(bothFalse).toEqual({ mode: 'fresh', deprecatedUsed: true, bothSet: true });
  });
});

describe('resolveMovementSessionMode', () => {
  it('inherits the score-resolved mode when the movement override is omitted', () => {
    expect(resolveMovementSessionMode('cumulative', undefined)).toBe('cumulative');
    expect(resolveMovementSessionMode('fresh', undefined)).toBe('fresh');
  });

  it('forces cumulative when the movement override is true', () => {
    expect(resolveMovementSessionMode('fresh', true)).toBe('cumulative');
    expect(resolveMovementSessionMode('cumulative', true)).toBe('cumulative');
  });

  it('forces fresh when the movement override is false', () => {
    expect(resolveMovementSessionMode('cumulative', false)).toBe('fresh');
    expect(resolveMovementSessionMode('fresh', false)).toBe('fresh');
  });

  it('does not mutate the score-resolved mode', () => {
    const scoreMode = 'fresh' as const;
    const resolved = resolveMovementSessionMode(scoreMode, true);
    expect(resolved).toBe('cumulative');
    expect(scoreMode).toBe('fresh');
  });
});