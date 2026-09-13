import { describe, it, expect } from 'vitest';
import {
  normalizeRequiredContext,
  findMissingRequiredContext,
  buildInitialSharedContext,
  RUNTIME_CONTEXT_KEYS,
} from '../required-context.js';
import type { RequiredContext } from '../types/score.js';

describe('normalizeRequiredContext', () => {
  it('returns an empty array for an undefined value', () => {
    expect(normalizeRequiredContext(undefined)).toEqual([]);
  });

  it('normalizes flat strings to { key } without a description', () => {
    const required: RequiredContext = ['ticket', 'project.name'];
    expect(normalizeRequiredContext(required)).toEqual([
      { key: 'ticket' },
      { key: 'project.name' },
    ]);
  });

  it('carries the description through for object entries', () => {
    const required: RequiredContext = [
      'ticket',
      { key: 'project.name', description: 'Namespace of the project to act on' },
    ];
    expect(normalizeRequiredContext(required)).toEqual([
      { key: 'ticket' },
      { key: 'project.name', description: 'Namespace of the project to act on' },
    ]);
  });

  it('trims whitespace-padded keys', () => {
    const required: RequiredContext = [
      ' ticket ',
      { key: ' project.name ', description: 'Namespace' },
    ];
    expect(normalizeRequiredContext(required)).toEqual([
      { key: 'ticket' },
      { key: 'project.name', description: 'Namespace' },
    ]);
  });

  it('preserves array ordering', () => {
    const required: RequiredContext = [
      { key: 'b', description: 'bee' },
      'a',
    ];
    expect(normalizeRequiredContext(required).map((i) => i.key)).toEqual(['b', 'a']);
  });
});

describe('findMissingRequiredContext', () => {
  it('returns keys whose value is undefined or null', () => {
    expect(findMissingRequiredContext(['ticket', 'project.name'], { ticket: 'P-1' })).toEqual([
      'project.name',
    ]);
  });

  it('treats falsy-but-present values as present', () => {
    expect(
      findMissingRequiredContext(['a', 'b', 'c'], { a: false, b: 0, c: '' }),
    ).toEqual([]);
  });

  it('resolves nested dot-paths', () => {
    expect(findMissingRequiredContext(['project.name'], { project: { name: 'x' } })).toEqual([]);
    expect(findMissingRequiredContext(['project.name'], { project: 'x' })).toEqual([
      'project.name',
    ]);
  });

  it('always treats runtime-injected keys as present', () => {
    // The CLI preflight validates before `createConcert` injects these keys, so
    // it must not reject a score that requires them.
    expect(findMissingRequiredContext([...RUNTIME_CONTEXT_KEYS], {})).toEqual([]);
  });
});

describe('buildInitialSharedContext', () => {
  it('injects runtime keys and lets them win over caller-supplied values', () => {
    const context = buildInitialSharedContext(
      { ticket: 'P-1', concertId: 'caller-supplied' },
      { concertId: 'real-concert', scoreId: 'real-score' },
    );
    expect(context).toEqual({
      ticket: 'P-1',
      concertId: 'real-concert',
      scoreId: 'real-score',
    });
  });

  it('satisfies the runtime keys it injects', () => {
    const context = buildInitialSharedContext(undefined, {
      concertId: 'c',
      scoreId: 's',
    });
    expect(findMissingRequiredContext([...RUNTIME_CONTEXT_KEYS], context)).toEqual([]);
  });
});
