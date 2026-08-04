import type { HarnessAdapter, HarnessResponse } from '../types/adapter.js';
import type { Goal, GoalEvaluation, ConcertContext } from '../types/index.js';
import { GoalEvalError } from '../types/errors.js';
import type { Evaluator } from './evaluator.js';
import { safeJsonParse, extractBalancedJson } from '../json-utils.js';

const goalEvaluationSchema = {
  type: 'object',
  properties: {
    achieved: { type: 'boolean' },
    confidence: { type: 'number' },
    summary: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['achieved', 'confidence', 'summary'],
} as const;

/**
 * Behavior when an evaluator response cannot be parsed into a valid
 * {@link GoalEvaluation}, even after all recovery/extraction attempts.
 *
 * - `failed` (default): degrade gracefully to an `achieved: false` evaluation
 *   so the concert never crashes on a chatty evaluator. The movement resolves
 *   through its normal (non-success) transition, and the raw adviser output is
 *   persisted in the summary/evidence for debugging.
 * - `passed`: degrade to an `achieved: true` evaluation. This is an explicit
 *   opt-in only; it is never the default because silently approving work the
 *   judge could not evaluate is unsafe.
 * - `retry`: throw a retryable {@link GoalEvalError} instead of degrading. This
 *   surfaces the infrastructure failure to a host that handles retryable
 *   evaluator errors (e.g. an out-of-band retry layer that re-attempts the
 *   evaluation). Opt-in only; the default never crashes the concert.
 */
export type DefaultOnParseFailure = 'failed' | 'passed' | 'retry';

/**
 * Configurable structurizer / second-model pass (issue #133, strategy 4 from
 * #103). When the configured judge model is known-flaky (small flash-tier
 * models being the usual offender) and its output cannot be parsed into a valid
 * {@link GoalEvaluation}, a separate extraction model is invoked to convert the
 * raw judge output into strict JSON. This decouples *judgment* (cheap model)
 * from *formatting* (any model that reliably emits JSON).
 */
export interface EvaluatorStructurizerConfig {
  /** Model to use for the repair/structuring pass. */
  model: string;
  /** Provider for the structurizer model. Defaults to the adapter's default. */
  provider?: string;
}

export interface HarnessEvaluatorConfig {
  adapter: HarnessAdapter;
  promptTemplate?: string;
  model?: string;
  provider?: string;
  /** How to react when the evaluator output cannot be parsed. Default `failed`. */
  defaultOnParseFailure?: DefaultOnParseFailure;
  /**
   * Optional second-model pass: when configured, unparseable judge output is
   * re-routed to this extraction model to be converted into JSON before falling
   * back to graceful degradation. Only invoked on the recovery path — no cost
   * when the judge's own output parses cleanly.
   */
  structurizer?: EvaluatorStructurizerConfig;
}

export class HarnessEvaluator implements Evaluator {
  constructor(private config: HarnessEvaluatorConfig) {}

  async evaluate(
    goal: Goal,
    output: string,
    context: ConcertContext,
    movementId?: string,
  ): Promise<GoalEvaluation> {
    const prompt = this.buildPrompt(goal, output, context, movementId);

    const response = await this.config.adapter.execute(prompt, context, {
      output: {
        mode: 'structured',
        schema: goalEvaluationSchema as unknown as Record<string, unknown>,
      },
      model: this.config.model,
      provider: this.config.provider,
    });

    const parsed = this.tryParseEvaluation(response);
    if (parsed) {
      return parsed;
    }

    // Configurable structurizer / second-model pass (strategy 4 from #103):
    // when the judge's own output is unparseable (common with flaky flash-tier
    // judge models), route the repair pass to a separate extraction model that
    // reliably emits JSON. Invoked only on the recovery path, so it has no cost
    // on the happy path.
    if (this.config.structurizer) {
      const structurized = await this.structurizeGoalEvaluation(
        response,
        goal,
        context,
        movementId,
        this.config.structurizer,
      );
      if (structurized) {
        return structurized;
      }
    }

    return this.degrade(response, goal, movementId);
  }

  /**
   * Invoke the structurizer model to convert raw judge text into a strict JSON
   * {@link GoalEvaluation}. Best-effort: any failure (adapter error or
   * unparseable result) yields `undefined` so the caller falls through to
   * graceful degradation.
   */
  private async structurizeGoalEvaluation(
    original: HarnessResponse,
    goal: Goal,
    context: ConcertContext,
    movementId: string | undefined,
    structurizer: EvaluatorStructurizerConfig,
  ): Promise<GoalEvaluation | undefined> {
    const raw = original.output.trim();
    if (!raw) {
      return undefined;
    }

    const prompt = [
      'You are a JSON formatter. Convert the free-form text below from a judge/evaluator model into ONE strict JSON object.',
      'Reply with ONLY the JSON object — no markdown fences, no commentary.',
      'The object must have these fields:',
      '  - "achieved": boolean',
      '  - "confidence": number between 0 and 1',
      '  - "summary": string (brief explanation of the judgment)',
      '  - "evidence": string (optional supporting evidence)',
      '',
      'If the text does not clearly indicate whether the goal was achieved, set "achieved" to false.',
      '',
      `Goal being evaluated: ${goal.description}`,
      `Movement ID: ${movementId ?? ''}`,
      'Judge raw output:',
      '```',
      raw,
      '```',
    ].join('\n');

    try {
      const response = await this.config.adapter.execute(prompt, context, {
        output: {
          mode: 'structured',
          schema: goalEvaluationSchema as unknown as Record<string, unknown>,
        },
        model: structurizer.model,
        provider: structurizer.provider,
        movementId,
      });
      return this.tryParseEvaluation(response);
    } catch {
      return undefined;
    }
  }

  private buildPrompt(
    goal: Goal,
    output: string,
    context: ConcertContext,
    movementId?: string,
  ): string {
    const template =
      this.config.promptTemplate ??
      `You are evaluating whether a movement achieved its goal.

Goal: {{goal.description}}
Movement output: {{output}}
Movement ID: {{movementId}}
Shared context: {{context}}

Return a JSON object with:
- "achieved": boolean
- "confidence": number between 0 and 1
- "summary": a brief explanation of your judgment
- "evidence": optional evidence supporting your judgment`;

    return template
      .replaceAll('{{goal.description}}', goal.description)
      .replaceAll('{{output}}', output)
      .replaceAll('{{movementId}}', movementId ?? '')
      .replaceAll('{{context}}', JSON.stringify(context.shared, null, 2));
  }

  /**
   * Attempt to parse the judge's response into a valid
   * {@link GoalEvaluation}. Returns `undefined` when it cannot — no degradation
   * here so callers can route unparseable output to the structurizer (strategy
   * 4) before falling through to {@link degrade}.
   */
  private tryParseEvaluation(
    response: HarnessResponse,
  ): GoalEvaluation | undefined {
    const structured = response.structured;
    if (this.isGoalEvaluation(structured)) {
      return structured;
    }

    const text = response.output.trim();
    if (text) {
      const parsed = this.extractGoalEvaluation(text);
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  /**
   * Graceful degradation: never let an unparseable evaluation kill the
   * concert. If the caller opted into `retry`, surface the infra failure as a
   * retryable error; otherwise fall back to a deterministic default so the
   * movement resolves through its normal (non-success) transition instead of
   * crashing the whole concert.
   */
  private degrade(
    response: HarnessResponse,
    _goal: Goal,
    movementId?: string,
  ): GoalEvaluation {
    const text = response.output.trim();

    const mode = this.config.defaultOnParseFailure ?? 'failed';
    if (mode === 'retry') {
      throw new GoalEvalError(
        `Evaluator could not parse a valid GoalEvaluation for movement '${movementId ?? 'unknown'}'`,
        'EVALUATOR_FAILURE',
        undefined,
        movementId,
      );
    }

    const truncated = this.truncate(text, 500);
    return {
      achieved: mode === 'passed',
      confidence: 0,
      summary: `Evaluator output unparseable: ${truncated || '(empty)'}`,
      // Persist the raw (untruncated) evaluator output on the movement record
      // so unparseable responses remain debuggable.
      evidence: text || undefined,
    };
  }

  private extractGoalEvaluation(text: string): GoalEvaluation | undefined {
    const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (blockMatch) {
      const parsed = safeJsonParse(blockMatch[1].trim());
      if (this.isGoalEvaluation(parsed)) {
        return parsed;
      }
    }

    const balanced = extractBalancedJson(text);
    if (balanced) {
      const parsed = safeJsonParse(balanced);
      if (this.isGoalEvaluation(parsed)) {
        return parsed;
      }
    }

    const parsed = safeJsonParse(text.trim());
    if (this.isGoalEvaluation(parsed)) {
      return parsed;
    }

    // Lenient pass: tolerate `key: value` lines, markdown bullets, and type
    // coercion. Accept only when all three required fields are present.
    return this.extractLenientGoalEvaluation(text);
  }

  /**
   * Tolerantly scan free-form evaluator text for the three required keys
   * (achieved / confidence / summary) without requiring valid JSON. Handles
   * `key: value` lines, markdown bullet lists, and type coercion (`"true"` →
   * boolean, `"0.9"` → number, trailing-punctuation-tolerant strings). Leniency
   * lives at extraction only: results are still validated strictly.
   */
  private extractLenientGoalEvaluation(text: string): GoalEvaluation | undefined {
    const achieved = this.extractBoolean(text, 'achieved');
    const confidence = this.extractNumber(text, 'confidence');
    const summary = this.extractString(text, 'summary');
    if (achieved !== undefined && confidence !== undefined && summary !== undefined) {
      return { achieved, confidence, summary };
    }
    return undefined;
  }

  private extractBoolean(text: string, key: string): boolean | undefined {
    const value = this.extractScalar(text, key);
    if (value === undefined) return undefined;
    const lower = value.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return undefined;
  }

  private extractNumber(text: string, key: string): number | undefined {
    const re = new RegExp(
      `(?:^|[\\s,{;\\-\\(\\[*])\\b${key}\\b\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i',
    );
    const match = re.exec(text);
    if (!match) return undefined;
    const num = Number(match[1]);
    return Number.isFinite(num) ? num : undefined;
  }

  private extractString(text: string, key: string): string | undefined {
    const re = new RegExp(
      `(?:^|[\\s,{;\\-\\(\\[*])\\b${key}\\b\\s*[:=]\\s*(.+?)(?=[,;\\n\\r}]|$)`, 'i',
    );
    const match = re.exec(text);
    if (!match) return undefined;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) return undefined;
    return value;
  }

  private extractScalar(text: string, key: string): string | undefined {
    const re = new RegExp(
      `(?:^|[\\s,{;\\-\\(\\[*])\\b${key}\\b\\s*[:=]\\s*(.+?)(?=[,;\\n\\r}]|$)`, 'i',
    );
    const match = re.exec(text);
    return match ? match[1].trim() : undefined;
  }

  private truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  }

  private isGoalEvaluation(value: unknown): value is GoalEvaluation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const v = value as Record<string, unknown>;
    return (
      typeof v.achieved === 'boolean' &&
      typeof v.confidence === 'number' &&
      typeof v.summary === 'string'
    );
  }
}
