import { describe, it, expect } from 'vitest';
import { normalizeRequiredContext } from '../required-context.js';
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

  it('preserves array ordering', () => {
    const required: RequiredContext = [
      { key: 'b', description: 'bee' },
      'a',
    ];
    expect(normalizeRequiredContext(required).map((i) => i.key)).toEqual(['b', 'a']);
  });
});
