import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScoreRegistry } from '../registry/score-registry.js';
import type { Score } from '../types/score.js';

const validScore = (overrides: Partial<Score> = {}): Score => ({
  id: 'test-workflow',
  name: 'Test Workflow',
  description: 'A test workflow',
  version: '1.0.0',
  startMovement: 'step_a',
  movements: [
    {
      id: 'step_a',
      name: 'Step A',
      section: 'default',
      description: 'First step',
      harness: 'pi',
      prompt: 'Do step A',
      goal: { description: 'Step A complete', strategy: 'llm_judge' },
      transitions: [{ to: 'step_b', on: 'success' }],
    },
    {
      id: 'step_b',
      name: 'Step B',
      section: 'default',
      description: 'Second step',
      harness: 'pi',
      prompt: 'Do step B',
      goal: { description: 'Step B complete', strategy: 'llm_judge' },
      transitions: [{ to: '__end__', on: 'success' }],
    },
  ],
  program: {},
  ...overrides,
});

describe('ScoreRegistry', () => {
  it('should register and retrieve a valid score', () => {
    const registry = new ScoreRegistry();
    const score = validScore();
    registry.register(score);

    const retrieved = registry.get('test-workflow');
    expect(retrieved.id).toBe('test-workflow');
    expect(retrieved.movements).toHaveLength(2);
  });

  it('should list all registered scores', () => {
    const registry = new ScoreRegistry();
    registry.register(validScore({ id: 'score-1' }));
    registry.register(validScore({ id: 'score-2' }));

    const list = registry.list();
    expect(list).toHaveLength(2);
  });

  it('should remove a score', () => {
    const registry = new ScoreRegistry();
    registry.register(validScore());
    registry.remove('test-workflow');

    expect(() => registry.get('test-workflow')).toThrow();
  });

  it('should reject a score without movements', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(validScore({ movements: [] })),
    ).toThrow('must have at least one movement');
  });

  it('should reject a score with unknown start movement', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(validScore({ startMovement: 'nonexistent' })),
    ).toThrow('not found in movements');
  });

  it('should reject a score with dangling transition target', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'step_a',
              name: 'Step A',
              section: 'default',
              description: 'First step',
              harness: 'pi',
              prompt: 'Do step A',
              goal: { description: 'Step A complete', strategy: 'llm_judge' },
              transitions: [{ to: 'ghost', on: 'success' }],
            },
          ],
          startMovement: 'step_a',
        }),
      ),
    ).toThrow('unknown movement');
  });

  it('should detect deadlock cycles with no terminal exit', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'a',
              name: 'A',
              section: 'default',
              description: 'Step A',
              harness: 'pi',
              prompt: 'Do A',
              goal: { description: 'A done', strategy: 'llm_judge' },
              transitions: [{ to: 'b', on: 'success' }],
            },
            {
              id: 'b',
              name: 'B',
              section: 'default',
              description: 'Step B',
              harness: 'pi',
              prompt: 'Do B',
              goal: { description: 'B done', strategy: 'llm_judge' },
              transitions: [{ to: 'a', on: 'success' }],
            },
          ],
          startMovement: 'a',
        }),
      ),
    ).toThrow('cycle detected');
  });

  it('should allow retry loops that have a terminal exit', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          id: 'retry-loop',
          movements: [
            {
              id: 'implement',
              name: 'Implement',
              section: 'execution',
              description: 'Write code',
              harness: 'pi',
              prompt: 'Implement',
              goal: { description: 'Done', strategy: 'llm_judge' },
              transitions: [{ to: 'review', on: 'success' }, { to: '__fail__', on: 'failure' }],
            },
            {
              id: 'review',
              name: 'Review',
              section: 'review',
              description: 'Review code',
              harness: 'pi',
              prompt: 'Review',
              goal: { description: 'Done', strategy: 'llm_judge' },
              transitions: [{ to: 'implement', on: 'failure' }, { to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'implement',
        }),
      ),
    ).not.toThrow();
  });

  it('should warn about unreachable movements', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'a',
              name: 'A',
              section: 'default',
              description: 'Start',
              harness: 'pi',
              prompt: 'Do A',
              goal: { description: 'A done', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
            {
              id: 'b',
              name: 'B',
              section: 'default',
              description: 'Unreachable',
              harness: 'pi',
              prompt: 'Do B',
              goal: { description: 'B done', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'a',
        }),
      ),
    ).toThrow('unreachable');
  });

  it('should reject a score without an id', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(validScore({ id: '' })),
    ).toThrow();
  });

  it('should reject a score without a version', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(validScore({ version: '' })),
    ).toThrow('must have a version');
  });

  it('should reject a score without a name', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(validScore({ name: '' })),
    ).toThrow();
  });

  it('should throw on get for an unregistered score', () => {
    const registry = new ScoreRegistry();
    expect(() => registry.get('nonexistent')).toThrow('not found');
  });

  it('should load a score from a YAML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestron-test-'));
    const path = join(dir, 'test-score.yaml');
    writeFileSync(path, `
id: yaml-score
name: "YAML Score"
description: "Loaded from YAML"
version: "1.0.0"
startMovement: step_a
movements:
  - id: step_a
    name: "Step A"
    section: default
    harness: pi
    prompt: "Do step A"
    goal:
      description: "done"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
program: {}
`, 'utf-8');

    const registry = new ScoreRegistry();
    registry.loadFrom(path);
    const score = registry.get('yaml-score');
    expect(score.name).toBe('YAML Score');
    expect(score.movements).toHaveLength(1);
  });

  it('should throw when loading from a nonexistent file', () => {
    const registry = new ScoreRegistry();
    expect(() => registry.loadFrom('/nonexistent/path.yaml')).toThrow('not found');
  });

  it('should register multiple scores at once', () => {
    const registry = new ScoreRegistry();
    registry.registerMany([
      validScore({ id: 'multi-a' }),
      validScore({ id: 'multi-b' }),
    ]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get('multi-a').id).toBe('multi-a');
    expect(registry.get('multi-b').id).toBe('multi-b');
  });

  it('should overwrite on duplicate registration', () => {
    const registry = new ScoreRegistry();
    registry.register(validScore({ name: 'Original' }));
    registry.register(validScore({ name: 'Overwrite' }));
    const score = registry.get('test-workflow');
    expect(score.name).toBe('Overwrite');
  });

  it('should reject a dual prompt missing initial', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'step_a',
              name: 'Step A',
              section: 'default',
              description: 'First step',
              harness: 'pi',
              prompt: { initial: '', subsequent: 'subsequent' } as any,
              goal: { description: 'Step A complete', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'step_a',
        }),
      ),
    ).toThrow('dual prompt');
  });

  it('should reject a dual prompt missing subsequent', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'step_a',
              name: 'Step A',
              section: 'default',
              description: 'First step',
              harness: 'pi',
              prompt: { initial: 'initial', subsequent: '' } as any,
              goal: { description: 'Step A complete', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'step_a',
        }),
      ),
    ).toThrow('dual prompt');
  });

  it('should reject a dual prompt with non-string initial', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'step_a',
              name: 'Step A',
              section: 'default',
              description: 'First step',
              harness: 'pi',
              prompt: { initial: 123 as any, subsequent: 'subsequent' },
              goal: { description: 'Step A complete', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'step_a',
        }),
      ),
    ).toThrow('dual prompt');
  });

  it('should reject a dual prompt with non-string subsequent', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'step_a',
              name: 'Step A',
              section: 'default',
              description: 'First step',
              harness: 'pi',
              prompt: { initial: 'initial', subsequent: 456 as any },
              goal: { description: 'Step A complete', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'step_a',
        }),
      ),
    ).toThrow('dual prompt');
  });

  it('should accept a valid dual prompt', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        validScore({
          movements: [
            {
              id: 'step_a',
              name: 'Step A',
              section: 'default',
              description: 'First step',
              harness: 'pi',
              prompt: { initial: 'first', subsequent: 'later' },
              goal: { description: 'Step A complete', strategy: 'llm_judge' },
              transitions: [{ to: '__end__', on: 'success' }],
            },
          ],
          startMovement: 'step_a',
        }),
      ),
    ).not.toThrow();
  });
});
