import { describe, it, expect, vi } from 'vitest';
import { HarnessEvaluator } from './harness-evaluator.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { GoalEvalError } from '../types/errors.js';
import type { Goal, ConcertContext } from '../types/index.js';

describe('HarnessEvaluator', () => {
  const goal: Goal = {
    description: 'The output is a valid plan',
    strategy: 'llm_judge',
  };

  const context: ConcertContext = { shared: { task: 'Build a login' } };

  it('returns a structured evaluation from the adapter response', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":true,"confidence":0.95,"summary":"Plan is valid"}',
        structured: {
          achieved: true,
          confidence: 0.95,
          summary: 'Plan is valid',
          evidence: 'Includes steps and tests',
        },
        summary: 'Evaluated',
        usage: { spend: 1, tokens: 10 },
      },
    });
    const evaluator = new HarnessEvaluator({ adapter });

    const result = await evaluator.evaluate(goal, 'Step 1: Design', context, 'plan');

    expect(result.achieved).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.summary).toBe('Plan is valid');
    expect(result.evidence).toBe('Includes steps and tests');
  });

  it('falls back to parsing raw output when structured is missing or invalid', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":false,"confidence":0.2,"summary":"No tests"}',
        summary: 'Evaluated',
        usage: { spend: 1, tokens: 10 },
      },
    });
    const evaluator = new HarnessEvaluator({ adapter });

    const result = await evaluator.evaluate(goal, 'bad output', context);

    expect(result.achieved).toBe(false);
    expect(result.confidence).toBe(0.2);
    expect(result.summary).toBe('No tests');
  });

  it('throws GoalEvalError when the response cannot be parsed', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'not valid json',
        summary: 'Evaluated',
        usage: { spend: 1, tokens: 10 },
      },
    });
    const evaluator = new HarnessEvaluator({ adapter });

    await expect(evaluator.evaluate(goal, 'output', context)).rejects.toBeInstanceOf(GoalEvalError);
  });

  it('extracts goal evaluation from a markdown JSON block', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'Some text\n```json\n{"achieved":true,"confidence":0.9,"summary":"Good"}\n```\nMore text',
        summary: 'Evaluated',
        usage: {},
      },
    });
    const evaluator = new HarnessEvaluator({ adapter });

    const result = await evaluator.evaluate(goal, 'output', context);
    expect(result.achieved).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.summary).toBe('Good');
  });

  it('extracts goal evaluation from an embedded JSON object', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'Here is the result: {"achieved":false,"confidence":0.1,"summary":"Bad"} thanks!',
        summary: 'Evaluated',
        usage: {},
      },
    });
    const evaluator = new HarnessEvaluator({ adapter });

    const result = await evaluator.evaluate(goal, 'output', context);
    expect(result.achieved).toBe(false);
    expect(result.confidence).toBe(0.1);
    expect(result.summary).toBe('Bad');
  });

  it('uses a custom prompt template', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":true,"confidence":1,"summary":"OK"}',
        summary: 'Evaluated',
        usage: {},
      },
    });
    const executeSpy = vi.spyOn(adapter, 'execute');
    const evaluator = new HarnessEvaluator({
      adapter,
      promptTemplate: 'Goal: {{goal.description}} | Output: {{output}} | Movement: {{movementId}}',
    });

    await evaluator.evaluate(goal, 'the output', context, 'm1');

    const prompt = executeSpy.mock.calls[0][0];
    expect(prompt).toContain('Goal: The output is a valid plan');
    expect(prompt).toContain('Output: the output');
    expect(prompt).toContain('Movement: m1');
  });

  it('requests structured output from the adapter', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":true,"confidence":1,"summary":"OK"}',
        structured: { achieved: true, confidence: 1, summary: 'OK' },
        summary: 'Evaluated',
        usage: {},
      },
    });
    const executeSpy = vi.spyOn(adapter, 'execute');
    const evaluator = new HarnessEvaluator({ adapter });

    await evaluator.evaluate(goal, 'output', context);

    const options = executeSpy.mock.calls[0][2];
    expect(options?.output?.mode).toBe('structured');
    expect(options?.output?.schema).toBeDefined();
  });

  it('forwards model and provider to the adapter', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":true,"confidence":1,"summary":"OK"}',
        structured: { achieved: true, confidence: 1, summary: 'OK' },
        summary: 'Evaluated',
        usage: {},
      },
    });
    const executeSpy = vi.spyOn(adapter, 'execute');
    const evaluator = new HarnessEvaluator({
      adapter,
      model: 'pi-4-mini',
      provider: 'pi',
    });

    await evaluator.evaluate(goal, 'output', context);

    const options = executeSpy.mock.calls[0][2];
    expect(options?.model).toBe('pi-4-mini');
    expect(options?.provider).toBe('pi');
  });

  it('omits model and provider from adapter options when not configured', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":true,"confidence":1,"summary":"OK"}',
        structured: { achieved: true, confidence: 1, summary: 'OK' },
        summary: 'Evaluated',
        usage: {},
      },
    });
    const executeSpy = vi.spyOn(adapter, 'execute');
    const evaluator = new HarnessEvaluator({ adapter });

    await evaluator.evaluate(goal, 'output', context);

    const options = executeSpy.mock.calls[0][2];
    expect(options?.model).toBeUndefined();
    expect(options?.provider).toBeUndefined();
  });
});
