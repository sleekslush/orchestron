import { describe, it, expect } from 'vitest';
import { matchTransition } from '../conductor/transition-resolver.js';
import type { Movement, Transition } from '../types/score.js';

function makeMovement(transitions: Transition[]): Movement {
  return {
    id: 'test',
    name: 'Test',
    section: 'default',
    description: 'test movement',
    goal: { description: 'done', strategy: 'llm_judge' },
    transitions,
  };
}

describe('matchTransition', () => {
  describe('wildcard (any)', () => {
    it('matches `any` when movement succeeds', () => {
      const movement = makeMovement([{ to: '__end__', on: 'any' }]);
      const result = matchTransition(movement, 'success');
      expect(result).toEqual({ to: '__end__', on: 'any' });
    });

    it('matches `any` when movement fails', () => {
      const movement = makeMovement([{ to: '__fail__', on: 'any' }]);
      const result = matchTransition(movement, 'failure');
      expect(result).toEqual({ to: '__fail__', on: 'any' });
    });

    it('matches `any` when movement is rejected', () => {
      const movement = makeMovement([{ to: 'fallback', on: 'any' }]);
      const result = matchTransition(movement, 'rejection');
      expect(result).toEqual({ to: 'fallback', on: 'any' });
    });
  });

  describe('exact match priority', () => {
    it('prefers exact `success` over `any`', () => {
      const movement = makeMovement([
        { to: 'on_success', on: 'success' },
        { to: 'fallback', on: 'any' },
      ]);
      const result = matchTransition(movement, 'success');
      expect(result).toEqual({ to: 'on_success', on: 'success' });
    });

    it('prefers exact `failure` over `any`', () => {
      const movement = makeMovement([
        { to: 'on_failure', on: 'failure' },
        { to: 'fallback', on: 'any' },
      ]);
      const result = matchTransition(movement, 'failure');
      expect(result).toEqual({ to: 'on_failure', on: 'failure' });
    });

    it('prefers exact `rejection` over `any`', () => {
      const movement = makeMovement([
        { to: 'on_rejection', on: 'rejection' },
        { to: 'fallback', on: 'any' },
      ]);
      const result = matchTransition(movement, 'rejection');
      expect(result).toEqual({ to: 'on_rejection', on: 'rejection' });
    });

    it('falls back to `any` when exact match is absent', () => {
      const movement = makeMovement([
        { to: 'on_success', on: 'success' },
        { to: 'fallback', on: 'any' },
      ]);
      const result = matchTransition(movement, 'failure');
      expect(result).toEqual({ to: 'fallback', on: 'any' });
    });

    it('routes rejection to its own transition, not `failure`', () => {
      const movement = makeMovement([
        { to: 'on_failure', on: 'failure' },
        { to: 'on_rejection', on: 'rejection' },
      ]);
      const result = matchTransition(movement, 'rejection');
      expect(result).toEqual({ to: 'on_rejection', on: 'rejection' });
      expect(matchTransition(movement, 'failure')).toEqual({
        to: 'on_failure',
        on: 'failure',
      });
    });
  });

  describe('no match', () => {
    it('returns undefined when no transition matches', () => {
      const movement = makeMovement([
        { to: '__end__', on: 'success' },
      ]);
      const result = matchTransition(movement, 'failure');
      expect(result).toBeUndefined();
    });

    it('returns undefined for empty transitions', () => {
      const movement = makeMovement([]);
      const result = matchTransition(movement, 'success');
      expect(result).toBeUndefined();
    });
  });

  describe('ordering', () => {
    it('returns the first matching transition when multiple `any` exist', () => {
      const movement = makeMovement([
        { to: 'first', on: 'any' },
        { to: 'second', on: 'any' },
      ]);
      const result = matchTransition(movement, 'success');
      expect(result).toEqual({ to: 'first', on: 'any' });
    });
  });
});
