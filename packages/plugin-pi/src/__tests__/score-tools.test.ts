import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestron, type Orchestron } from '../orchestron.js';
import { createScore } from '../tools/create-score.js';
import { editScore } from '../tools/edit-score.js';
import { getScore } from '../tools/get-score.js';
import { listScores } from '../tools/list-scores.js';

const validYaml = `id: test-score
name: "Test Score"
version: "1.0.0"
startMovement: step_a
program:
  maxMovements: 10
movements:
  - id: step_a
    name: "Step A"
    section: planning
    harness: fake
    prompt: "Do step A"
    goal:
      description: "Step A is done"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
`;

const invalidYaml = `id: test-score
name: "Test Score"
version: "1.0.0"
startMovement: missing
program: {}
movements: []
`;

async function createTestOrchestron(): Promise<{ orchestron: Orchestron; tempDir: string }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'orchestron-score-test-'));
  const orchestron = await createOrchestron({
    storePath: ':memory:',
    scoresDirs: [tempDir],
    adapters: new Map(),
  });
  return { orchestron, tempDir };
}

describe('Score authoring tools', () => {
  let tempDir: string;
  let orchestron: Orchestron;

  beforeEach(async () => {
    const setup = await createTestOrchestron();
    tempDir = setup.tempDir;
    orchestron = setup.orchestron;
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates a valid score in memory only', async () => {
    const result = await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: false,
    });

    expect(result.scoreId).toBe('test-score');
    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.errors).toHaveLength(0);

    const registered = orchestron.registry.get('test-score');
    expect(registered.name).toBe('Test Score');
  });

  it('creates and persists a valid score', async () => {
    const result = await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: true,
    });

    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.path).toContain('test-score.score.yaml');
  });

  it('does not save or register an invalid score', async () => {
    const result = await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: invalidYaml,
      persist: true,
    });

    expect(result.valid).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    expect(() => orchestron.registry.get('test-score')).toThrow();
  });

  it('errors when creating a score that already exists on disk', async () => {
    await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: true,
    });

    const result = await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: true,
    });

    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_SCORE');
  });

  it('sanitizes unsafe score ids', async () => {
    const result = await createScore(orchestron, {
      scoreId: 'My Score!',
      yaml: validYaml.replace('id: test-score', 'id: my-score'),
      persist: true,
    });

    expect(result.scoreId).toBe('my-score');
    expect(result.valid).toBe(true);
    expect(result.path).toContain('my-score.score.yaml');
  });

  it('rejects score ids that cannot be sanitized', async () => {
    await expect(
      createScore(orchestron, {
        scoreId: '!@#$%',
        yaml: validYaml,
        persist: false,
      }),
    ).rejects.toThrow();
  });

  it('edits an existing in-memory score without persisting', async () => {
    await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: false,
    });

    const updatedYaml = validYaml.replace('Test Score', 'Updated Score');
    const result = await editScore(orchestron, {
      scoreId: 'test-score',
      yaml: updatedYaml,
      persist: false,
    });

    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(false);

    const registered = orchestron.registry.get('test-score');
    expect(registered.name).toBe('Updated Score');
  });

  it('edits and persists a score', async () => {
    await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: true,
    });

    const updatedYaml = validYaml.replace('Test Score', 'Updated Score');
    const result = await editScore(orchestron, {
      scoreId: 'test-score',
      yaml: updatedYaml,
      persist: true,
    });

    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(true);

    const state = await getScore(orchestron, { scoreId: 'test-score' });
    expect(state.yaml).toContain('Updated Score');
  });

  it('does not change file when edit validation fails', async () => {
    await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: true,
    });

    const result = await editScore(orchestron, {
      scoreId: 'test-score',
      yaml: invalidYaml,
      persist: true,
    });

    expect(result.valid).toBe(false);
    expect(result.persisted).toBe(false);

    const state = await getScore(orchestron, { scoreId: 'test-score' });
    expect(state.yaml).toContain('Test Score');
  });

  it('errors when editing a non-existent score', async () => {
    const result = await editScore(orchestron, {
      scoreId: 'missing',
      yaml: validYaml.replace('id: test-score', 'id: missing'),
      persist: false,
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('not found');
  });

  it('gets a persisted score', async () => {
    await createScore(orchestron, {
      scoreId: 'test-score',
      yaml: validYaml,
      persist: true,
    });

    const state = await getScore(orchestron, { scoreId: 'test-score' });
    expect(state.scoreId).toBe('test-score');
    expect(state.persisted).toBe(true);
    expect(state.yaml).toContain('Test Score');
    expect(state.path).toContain('test-score.score.yaml');
  });

  it('lists scores with persisted flag', async () => {
    await createScore(orchestron, {
      scoreId: 'memory-score',
      yaml: validYaml.replace('id: test-score', 'id: memory-score'),
      persist: false,
    });

    await createScore(orchestron, {
      scoreId: 'file-score',
      yaml: validYaml.replace('id: test-score', 'id: file-score'),
      persist: true,
    });

    const result = await listScores(orchestron);
    const memory = result.scores.find((s) => s.id === 'memory-score');
    const file = result.scores.find((s) => s.id === 'file-score');

    expect(memory?.persisted).toBe(false);
    expect(file?.persisted).toBe(true);
  });
});
