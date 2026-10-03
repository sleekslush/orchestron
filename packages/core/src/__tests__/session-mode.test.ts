import { describe, it, expect } from 'vitest';
import { resolveSessionMode } from '../conductor/session-mode.js';
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