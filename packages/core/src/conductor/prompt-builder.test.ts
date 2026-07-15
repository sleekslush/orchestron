import { describe, it, expect } from 'vitest';
import { PromptBuilder } from './prompt-builder.js';
import type { Movement, MovementID } from '../types/score.js';
import type { MovementRecord } from '../types/concert.js';

function makeRecord(overrides: Partial<MovementRecord> & { movementId: MovementID }): MovementRecord {
  return {
    movementName: 'Test',
    status: 'completed',
    output: '',
    summary: '',
    goalEvaluation: { achieved: true, confidence: 1, summary: 'Done' },
    usage: { spend: 0, tokens: 0 },
    durationMs: 0,
    startedAt: new Date(),
    ...overrides,
  };
}

describe('PromptBuilder', () => {
  describe('resolveTemplate', () => {
    it('replaces simple {{context.key}} placeholders', () => {
      const pb = new PromptBuilder();
      const result = pb.resolveTemplate(
        'Hello {{context.name}}!',
        new Map(),
        { name: 'World' },
      );
      expect(result).toBe('Hello World!');
    });

    it('replaces {{context.previousOutputs.<id>}} with full text output', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Step 1: Analysis\nStep 2: Implementation',
      }));

      const result = pb.resolveTemplate(
        'Previous: {{context.previousOutputs.plan}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Previous: Step 1: Analysis\nStep 2: Implementation');
    });

    it('replaces {{context.previousOutputs.<id>.<path>}} with structured field value (string)', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('analyze', makeRecord({
        movementId: 'analyze',
        output: 'Structured output here',
        structured: { summary: 'Analysis complete', confidence: 0.95 },
      }));

      const result = pb.resolveTemplate(
        'Summary: {{context.previousOutputs.analyze.summary}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Summary: Analysis complete');
    });

    it('replaces {{context.previousOutputs.<id>.<path>}} with structured field value (number)', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('analyze', makeRecord({
        movementId: 'analyze',
        output: 'Structured output here',
        structured: { confidence: 0.95, score: 42 },
      }));

      const result = pb.resolveTemplate(
        'Score: {{context.previousOutputs.analyze.score}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Score: 42');
    });

    it('replaces {{context.previousOutputs.<id>.<nested.path>}} with nested structured field', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Some output',
        structured: {
          meta: { version: 2, author: 'test' },
        },
      }));

      const result = pb.resolveTemplate(
        'Version: {{context.previousOutputs.plan.meta.version}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Version: 2');
    });

    it('replaces {{context.previousOutputs.<id>.<array>}} with JSON-stringified array', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Some output',
        structured: { steps: ['Analysis', 'Implementation', 'Testing'] },
      }));

      const result = pb.resolveTemplate(
        'Steps: {{context.previousOutputs.plan.steps}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Steps: [\n  "Analysis",\n  "Implementation",\n  "Testing"\n]');
    });

    it('replaces {{context.previousOutputs.<id>.<array>.<index>}} with array element', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Some output',
        structured: { steps: ['Analysis', 'Implementation', 'Testing'] },
      }));

      const result = pb.resolveTemplate(
        'First step: {{context.previousOutputs.plan.steps.0}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('First step: Analysis');
    });

    it('falls back to parsing output text when structured data is not available', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: '{"steps": ["Analysis", "Implementation"], "summary": "Done"}',
      }));

      const result = pb.resolveTemplate(
        'Summary: {{context.previousOutputs.plan.summary}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Summary: Done');
    });

    it('falls back to parsing JSON from markdown block when structured data is not available', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Here is the result:\n\n```json\n{"summary": "Extracted from markdown"}\n```',
      }));

      const result = pb.resolveTemplate(
        'Summary: {{context.previousOutputs.plan.summary}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Summary: Extracted from markdown');
    });

    it('leaves unrecognized paths as-is when structured data is missing', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Some text output (not JSON)',
      }));

      const result = pb.resolveTemplate(
        'Missing: {{context.previousOutputs.plan.nonexistent}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Missing: {{context.previousOutputs.plan.nonexistent}}');
    });

    it('leaves unrecognized nested paths as-is when path does not exist in structured data', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Some output',
        structured: { steps: ['a', 'b'] },
      }));

      const result = pb.resolveTemplate(
        'Missing: {{context.previousOutputs.plan.meta.version}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Missing: {{context.previousOutputs.plan.meta.version}}');
    });

    it('leaves out-of-bounds array index as-is', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Some output',
        structured: { steps: ['a', 'b'] },
      }));

      const result = pb.resolveTemplate(
        'Index 5: {{context.previousOutputs.plan.steps.5}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Index 5: {{context.previousOutputs.plan.steps.5}}');
    });

    it('handles multiple placeholders in the same template', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('analyze', makeRecord({
        movementId: 'analyze',
        output: 'Some output',
        structured: { summary: 'Great', confidence: 0.9 },
      }));

      const result = pb.resolveTemplate(
        'Summary: {{context.previousOutputs.analyze.summary}} (confidence: {{context.previousOutputs.analyze.confidence}})',
        previousOutputs,
        {},
      );
      expect(result).toBe('Summary: Great (confidence: 0.9)');
    });

    it('does not confuse a shorter movement ID with a longer one', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Short plan output',
        structured: { steps: ['a'] },
      }));
      previousOutputs.set('planning', makeRecord({
        movementId: 'planning',
        output: 'Longer planning output',
        structured: { steps: ['x', 'y'] },
      }));

      const result = pb.resolveTemplate(
        'Short: {{context.previousOutputs.plan.steps.0}} | Long: {{context.previousOutputs.planning.steps.1}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Short: a | Long: y');
    });

    it('passes through templates with no placeholders', () => {
      const pb = new PromptBuilder();
      const result = pb.resolveTemplate(
        'Just some plain text with no substitutions.',
        new Map(),
        {},
      );
      expect(result).toBe('Just some plain text with no substitutions.');
    });

    it('handles movement IDs with regex special characters (dot)', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan.v2', makeRecord({
        movementId: 'plan.v2',
        output: 'Full output',
        structured: { summary: 'v2 result' },
      }));

      const result = pb.resolveTemplate(
        'Dot: {{context.previousOutputs.plan.v2.summary}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Dot: v2 result');
    });

    it('handles movement IDs with regex special characters (brackets)', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('step[1]', makeRecord({
        movementId: 'step[1]',
        output: 'Bracket output',
        structured: { result: 'ok' },
      }));

      const result = pb.resolveTemplate(
        'Bracket: {{context.previousOutputs.step[1].result}}',
        previousOutputs,
        {},
      );
      expect(result).toBe('Bracket: ok');
    });

    it('traverses into record.structured when it is an object', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'unused',
        structured: { analysis: { score: 85, tags: ['bug'] } },
      }));

      const tag = pb.resolveTemplate(
        'Tag: {{context.previousOutputs.plan.analysis.tags.0}}',
        previousOutputs,
        {},
      );
      expect(tag).toBe('Tag: bug');
    });

    it('leaves placeholder as-is when structured is null', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'text output',
        structured: null as unknown as undefined,
      }));

      const result = pb.resolveTemplate(
        'Null: {{context.previousOutputs.plan.nonexistent}}',
        previousOutputs,
        {},
      );
      // Falls back to parsing text 'text output' which isn't JSON,
      // so the placeholder is left as-is
      expect(result).toBe('Null: {{context.previousOutputs.plan.nonexistent}}');
    });

    it('interpolates both contextShared and previousOutputs placeholders', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Full plan output',
        structured: { title: 'My Plan' },
      }));

      const result = pb.resolveTemplate(
        'Task: {{context.task}} | Title: {{context.previousOutputs.plan.title}}',
        previousOutputs,
        { task: 'Build feature' },
      );
      expect(result).toBe('Task: Build feature | Title: My Plan');
    });
  });

  describe('buildPrompt', () => {
    it('resolves placeholders from context and previous outputs', () => {
      const pb = new PromptBuilder();
      const previousOutputs = new Map<MovementID, MovementRecord>();
      previousOutputs.set('plan', makeRecord({
        movementId: 'plan',
        output: 'Step 1: Research',
      }));

      const movement: Movement = {
        id: 'review',
        name: 'Review',
        section: 'x',
        description: 'x',
        prompt: 'Task: {{context.task}}\nPlan: {{context.previousOutputs.plan}}',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      };

      const result = pb.buildPrompt(
        movement,
        previousOutputs,
        { task: 'Build feature' },
      );
      expect(result).toBe('Task: Build feature\nPlan: Step 1: Research');
    });

    it('returns empty string when movement has no prompt', () => {
      const pb = new PromptBuilder();
      const movement: Movement = {
        id: 'no-prompt',
        name: 'No Prompt',
        section: 'x',
        description: 'x',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      };

      const result = pb.buildPrompt(movement, new Map(), {});
      expect(result).toBe('');
    });

    it('selects initial prompt on first visit', () => {
      const pb = new PromptBuilder();
      const movement: Movement = {
        id: 'test',
        name: 'Test',
        section: 'x',
        description: 'x',
        prompt: { initial: 'First time', subsequent: 'Again' },
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      };

      expect(pb.buildPrompt(movement, new Map(), {})).toBe('First time');
    });

    it('selects subsequent prompt on revisit', () => {
      const pb = new PromptBuilder();
      const movement: Movement = {
        id: 'test',
        name: 'Test',
        section: 'x',
        description: 'x',
        prompt: { initial: 'First time', subsequent: 'Again' },
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      };

      pb.recordVisit('test');
      expect(pb.buildPrompt(movement, new Map(), {})).toBe('Again');
    });
  });
});
