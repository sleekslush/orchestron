import type {
  Concert,
  ConcertID,
  ConcertStatus,
  MovementRecord,
  SerializedError,
} from '../types/concert.js';
import type {
  Score,
  Movement,
  MovementID,
  Program,
  Transition,
} from '../types/score.js';
import type { HarnessAdapter } from '../types/adapter.js';
import type { Evaluator } from '../evaluator/evaluator.js';
import type { ConcertStore } from '../store/concert-store.js';
import type { ConcertHall } from '../hall/concert-hall.js';
import {
  ConstraintBreachError,
  ConductorPanic,
  HarnessError,
  OrchestronError,
} from '../types/errors.js';

export interface StartOptions {
  initialContext?: Record<string, unknown>;
  programOverride?: Partial<Program>;
  triggeredBy?: Concert['triggeredBy'];
  parentConcertId?: ConcertID;
  nestingDepth?: number;
}

export class Conductor {
  private abortController = new AbortController();
  private pauseResolver: (() => void) | null = null;
  private _status: ConcertStatus = 'pending';
  private startedAt = 0;
  private nestingDepth: number;
  private activeSessions = new Map<string, HarnessAdapter>();

  constructor(
    private concert: Concert,
    private score: Score,
    private store: ConcertStore,
    private hall: ConcertHall,
    private adapters: ReadonlyMap<string, HarnessAdapter>,
    private evaluator: Evaluator,
  ) {
    this._status = concert.status;
    this.nestingDepth = 0;
  }

  get concertId(): ConcertID {
    return this.concert.id;
  }

  get scoreId(): string {
    return this.score.id;
  }

  get status(): ConcertStatus {
    return this._status;
  }

  async start(options?: StartOptions): Promise<void> {
    if (this._status !== 'pending') {
      throw new ConductorPanic(
        `Cannot start concert '${this.concert.id}': status is ${this._status}`,
      );
    }

    if (options?.initialContext) {
      this.concert.context = {
        shared: { ...options?.initialContext, ...this.concert.context.shared },
      };
    }

    if (options?.nestingDepth !== undefined) {
      this.nestingDepth = options.nestingDepth;
    } else if (this.concert.parentConcertId) {
      this.nestingDepth = 1;
    }

    this.concert.status = 'running';
    this._status = 'running';
    this.startedAt = Date.now();
    await this.store.updateConcert({
      id: this.concert.id,
      status: 'running',
      context: this.concert.context,
    });
    await this.store.pushEvent({
      type: 'concert:started',
      concertId: this.concert.id,
      scoreId: this.score.id,
      timestamp: new Date(),
    });

    const signal = this.abortController.signal;
    const previousOutputs = new Map<MovementID, MovementRecord>();

    try {
      await this.runLoop(this.score.startMovement, previousOutputs, 0, signal);
    } catch (err) {
      await this.handleExecutionError(err);
    }
  }

  async recover(): Promise<void> {
    const stored = await this.store.getConcert(this.concert.id);
    if (stored) {
      this.concert = stored;
    }

    if (this._status !== 'running' && this._status !== 'paused') {
      throw new ConductorPanic(
        `Cannot recover concert '${this.concert.id}': status is ${this._status}`,
        'STATE_CORRUPTION',
        this.concert.id,
      );
    }

    this._status = 'running';
    this.concert.status = 'running';
    this.startedAt = Date.now();

    await this.store.updateConcert({ id: this.concert.id, status: 'running' });
    await this.store.pushEvent({
      type: 'concert:started',
      concertId: this.concert.id,
      scoreId: this.score.id,
      timestamp: new Date(),
    });

    const signal = this.abortController.signal;
    const previousOutputs = new Map<MovementID, MovementRecord>();

    try {
      let currentId: MovementID | '__end__' | '__fail__';
      let movementCount = 0;

      if (this.concert.currentMovement) {
        const failedMovement = this.score.movements.find(
          (m) => m.id === this.concert.currentMovement,
        );

        if (failedMovement) {
          movementCount++;
          this.checkMovementLimit(movementCount, failedMovement.id);

          const error: SerializedError = {
            code: 'STATE_CORRUPTION',
            message: 'Process crashed during this movement',
            retryable: false,
            concertId: this.concert.id,
            movementId: failedMovement.id,
          };

          const failedRecord: MovementRecord = {
            movementId: failedMovement.id,
            movementName: failedMovement.name,
            status: 'failed',
            output: '',
            summary: 'Movement failed during crash recovery',
            goalEvaluation: { achieved: false, confidence: 0, summary: 'Interrupted by crash' },
            usage: {},
            durationMs: 0,
            startedAt: new Date(),
            completedAt: new Date(),
            error,
          };

          await this.store.appendMovement(this.concert.id, failedRecord);
          await this.store.pushEvent({
            type: 'movement:failed',
            concertId: this.concert.id,
            movementId: failedMovement.id,
            error,
            retryCount: 0,
            timestamp: new Date(),
          });

          this.concert.history.push(failedRecord);
          previousOutputs.set(failedMovement.id, failedRecord);

          const transition = this.matchTransition(failedMovement, false);
          currentId = transition?.to ?? '__fail__';
        } else {
          currentId = '__fail__';
        }
      } else {
        currentId = this.score.startMovement;
      }

      await this.runLoop(currentId, previousOutputs, movementCount, signal);
    } catch (err) {
      await this.handleExecutionError(err);
    }
  }

  async pause(): Promise<void> {
    if (this._status !== 'running') return;
    this._status = 'paused';
    this.concert.status = 'paused';
    await this.store.updateConcert({ id: this.concert.id, status: 'paused' });
    await this.store.pushEvent({
      type: 'concert:paused',
      concertId: this.concert.id,
      timestamp: new Date(),
    });
  }

  async resume(): Promise<void> {
    if (this._status !== 'paused') return;
    this._status = 'running';
    this.concert.status = 'running';
    this.pauseResolver?.();
    this.pauseResolver = null;
    await this.store.updateConcert({ id: this.concert.id, status: 'running' });
    await this.store.pushEvent({
      type: 'concert:resumed',
      concertId: this.concert.id,
      timestamp: new Date(),
    });
  }

  async cancel(): Promise<void> {
    this.abortController.abort();
    if (this._status === 'paused') {
      this.pauseResolver?.();
      this.pauseResolver = null;
    }
  }

  async getState(): Promise<Concert> {
    const stored = await this.store.getConcert(this.concert.id);
    if (stored) {
      this.concert = stored;
    }
    return { ...this.concert };
  }

  private async executeMovement(
    movement: Movement,
    previousOutputs: Map<MovementID, MovementRecord>,
    signal: AbortSignal,
  ): Promise<MovementRecord> {
    const startedAt = new Date();

    await this.store.pushEvent({
      type: 'movement:started',
      concertId: this.concert.id,
      movementId: movement.id,
      timestamp: startedAt,
    });

    const record: MovementRecord = {
      movementId: movement.id,
      movementName: movement.name,
      status: 'in_progress',
      output: '',
      summary: '',
      goalEvaluation: { achieved: false, confidence: 0, summary: '' },
      usage: {},
      durationMs: 0,
      startedAt,
    };

    try {
      if (movement.subscore) {
        return await this.executeSubscore(movement, previousOutputs, signal, record);
      }

      const adapter = this.resolveAdapter(movement);
      const prompt = this.buildPrompt(movement, previousOutputs);
      const persistSession = this.score.program.persistSession !== false;
      const sessionId = persistSession ? `${this.concert.id}:${movement.id}` : undefined;

      if (sessionId) {
        this.activeSessions.set(sessionId, adapter);
      }

      const response = await adapter.execute(prompt, this.concert.context, {
        signal,
        output: movement.output,
        movementId: movement.id,
        sessionId,
      });

      record.status = 'completed';
      record.output = response.output;
      if (response.structured) record.structured = response.structured;
      record.summary = response.summary;
      record.usage = response.usage;
      record.durationMs = Date.now() - startedAt.getTime();
    } catch (err) {
      record.status = 'failed';
      record.durationMs = Date.now() - startedAt.getTime();
      if (err instanceof OrchestronError) {
        record.error = {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          concertId: this.concert.id,
          movementId: movement.id,
        };
      } else {
        record.error = {
          code: 'UNKNOWN',
          message: (err as Error).message ?? 'Unknown error',
          retryable: false,
          concertId: this.concert.id,
          movementId: movement.id,
        };
      }
    }

    return record;
  }

  private async executeSubscore(
    movement: Movement,
    _previousOutputs: Map<MovementID, MovementRecord>,
    _signal: AbortSignal,
    record: MovementRecord,
  ): Promise<MovementRecord> {
    if (!movement.subscore) return record;

    const maxDepth = this.score.program.maxNestingDepth ?? 5;
    if (this.nestingDepth >= maxDepth) {
      throw new ConstraintBreachError(
        `Max nesting depth exceeded: ${this.nestingDepth + 1} > ${maxDepth}`,
        'MOVEMENT_LIMIT',
        maxDepth,
        this.nestingDepth + 1,
        'maxNestingDepth',
        this.concert.id,
      );
    }

    const childContext: Record<string, unknown> = {};
    for (const [key, sourcePath] of Object.entries(movement.subscore.contextMapping)) {
      const parts = sourcePath.split('.');
      let value: unknown = this.concert.context;
      for (const part of parts) {
        if (value && typeof value === 'object') {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }
      childContext[key] = value;
    }

    const childOptions: StartOptions = {
      initialContext: childContext,
      triggeredBy: this.concert.triggeredBy,
      parentConcertId: this.concert.id,
      nestingDepth: this.nestingDepth + 1,
    };

    const childConductor = await this.hall.createConcert(
      movement.subscore.scoreId,
      childOptions,
    );

    this.concert.childConcertIds.push(childConductor.concertId);

    await this.store.updateConcert({
      id: this.concert.id,
      childConcertIds: [...this.concert.childConcertIds],
    });

    await this.store.pushEvent({
      type: 'child:created',
      concertId: this.concert.id,
      childConcertId: childConductor.concertId,
      timestamp: new Date(),
    });

    await childConductor.start();

    const childConcert = await childConductor.getState();
    record.status = childConcert.status === 'completed' ? 'completed' : 'failed';
    record.output = childConcert.history
      .map((h) => `[${h.movementId}] ${h.summary}`)
      .join('\n');
    record.summary = `Sub-score '${movement.subscore.scoreId}' ${childConcert.status}`;

    for (const childRecord of childConcert.history) {
      if (childRecord.usage.spend || childRecord.usage.tokens) {
        record.usage.spend = (record.usage.spend ?? 0) + (childRecord.usage.spend ?? 0);
        record.usage.tokens = (record.usage.tokens ?? 0) + (childRecord.usage.tokens ?? 0);
      }
    }

    await this.store.pushEvent({
      type: 'child:completed',
      concertId: this.concert.id,
      childConcertId: childConductor.concertId,
      timestamp: new Date(),
    });

    return record;
  }

  private resolveAdapter(movement: Movement): HarnessAdapter {
    const type = movement.harness;
    if (!type) {
      throw new ConductorPanic(
        `Movement '${movement.id}' has no harness specified`,
        'INTERNAL_ERROR',
        this.concert.id,
      );
    }
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new ConductorPanic(
        `No adapter registered for harness type '${type}'`,
        'INTERNAL_ERROR',
        this.concert.id,
      );
    }
    return adapter;
  }

  private buildPrompt(
    movement: Movement,
    previousOutputs: Map<MovementID, MovementRecord>,
  ): string {
    if (!movement.prompt) return '';

    if (movement.output?.mode === 'structured' && movement.output.schema) {
      const schemaAppendix =
        `\n\nYou MUST return your response in the following JSON structure that conforms to this schema:\n` +
        `${JSON.stringify(movement.output.schema, null, 2)}`;
      return this.resolveTemplate(movement.prompt, movement.id, previousOutputs) + schemaAppendix;
    }

    return this.resolveTemplate(movement.prompt, movement.id, previousOutputs);
  }

  private resolveTemplate(
    template: string,
    _currentMovementId: MovementID,
    previousOutputs: Map<MovementID, MovementRecord>,
  ): string {
    let result = template;

    for (const [key, value] of Object.entries(this.concert.context.shared)) {
      const placeholder = `{{context.${key}}}`;
      result = result.replaceAll(placeholder, this.stringify(value));
    }

    for (const [id, record] of previousOutputs) {
      const placeholder = `{{context.previousOutputs.${id}}}`;
      result = result.replaceAll(placeholder, record.output);
    }

    return result;
  }

  private stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private matchTransition(
    movement: Movement,
    achieved: boolean,
  ): Transition | undefined {
    const status: 'success' | 'failure' = achieved ? 'success' : 'failure';
    return movement.transitions.find((t) => t.on === status || t.on === 'skip');
  }

  private checkMovementLimit(count: number, movementId: string): void {
    const maxMovements =
      this.score.program.maxMovements ??
      this.score.program.perSection?.['*']?.maxMovements ??
      100;
    if (count > maxMovements) {
      throw new ConstraintBreachError(
        `Movement limit exceeded: ${count} > ${maxMovements}`,
        'MOVEMENT_LIMIT',
        maxMovements,
        count,
        'maxMovements',
        this.concert.id,
      );
    }
  }

  private checkProgramConstraints(
    movement: Movement,
    record: MovementRecord,
  ): void {
    const totalSpend = (this.concert.usage.spend ?? 0) + (record.usage.spend ?? 0);
    const totalTokens = (this.concert.usage.tokens ?? 0) + (record.usage.tokens ?? 0);
    const program = this.score.program;

    if (program.maxSpend && totalSpend > program.maxSpend) {
      throw new ConstraintBreachError(
        `Spend limit exceeded: ${totalSpend} > ${program.maxSpend}`,
        'SPEND_LIMIT',
        program.maxSpend,
        totalSpend,
        'maxSpend',
        this.concert.id,
      );
    }
    if (program.maxTokens && totalTokens > program.maxTokens) {
      throw new ConstraintBreachError(
        `Token limit exceeded: ${totalTokens} > ${program.maxTokens}`,
        'TOKEN_LIMIT',
        program.maxTokens,
        totalTokens,
        'maxTokens',
        this.concert.id,
      );
    }
    if (program.maxDurationMs && this.startedAt > 0) {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed > program.maxDurationMs) {
        throw new ConstraintBreachError(
          `Duration limit exceeded: ${elapsed}ms > ${program.maxDurationMs}ms`,
          'DURATION_LIMIT',
          program.maxDurationMs,
          elapsed,
          'maxDurationMs',
          this.concert.id,
        );
      }
    }

    this.concert.usage.spend = totalSpend;
    this.concert.usage.tokens = totalTokens;
  }

  private async runLoop(
    startId: MovementID | '__end__' | '__fail__',
    previousOutputs: Map<MovementID, MovementRecord>,
    startCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    let currentId = startId;
    let movementCount = startCount;

    while (currentId !== '__end__' && currentId !== '__fail__') {
      if (signal.aborted) {
        await this.finalize('cancelled', 'Concert cancelled');
        return;
      }

      if ((this._status as ConcertStatus) === 'paused') {
        await this.waitForResume(signal);
      }

      const movement = this.score.movements.find((m) => m.id === currentId);
      if (!movement) {
        throw new ConductorPanic(
          `Movement '${currentId}' not found in score '${this.score.id}'`,
          'INTERNAL_ERROR',
          this.concert.id,
        );
      }

      movementCount++;
      this.checkMovementLimit(movementCount, movement.id);

      this.concert.currentMovement = movement.id;
      await this.store.updateConcert({
        id: this.concert.id,
        currentMovement: movement.id,
      });

      const record = await this.executeMovement(movement, previousOutputs, signal);

      if (record.status === 'failed' && movement.retryOnFailure) {
        const maxRetries = movement.budget?.maxRetries ?? 2;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          await this.store.pushEvent({
            type: 'movement:failed',
            concertId: this.concert.id,
            movementId: movement.id,
            error: record.error ?? { code: 'UNKNOWN', message: 'Unknown error', retryable: false },
            retryCount: attempt,
            timestamp: new Date(),
          });
          const retryRecord = await this.executeMovement(movement, previousOutputs, signal);
          if (retryRecord.status === 'completed') {
            Object.assign(record, retryRecord);
            break;
          }
          Object.assign(record, retryRecord);
        }
      }

      const evaluation = await this.evaluator.evaluate(
        movement.goal,
        record.output,
        this.concert.context,
        movement.id,
      );
      record.goalEvaluation = evaluation;
      record.completedAt = new Date();

      const achieved = evaluation.achieved && record.status === 'completed';
      record.status = achieved ? 'completed' : 'failed';

      await this.store.appendMovement(this.concert.id, record);
      if (achieved) {
        await this.store.pushEvent({
          type: 'movement:completed',
          concertId: this.concert.id,
          movementId: movement.id,
          result: record,
          timestamp: new Date(),
        });
      } else {
        await this.store.pushEvent({
          type: 'movement:failed',
          concertId: this.concert.id,
          movementId: movement.id,
          error: record.error ?? { code: 'GOAL_FAILURE', message: 'Goal not achieved', retryable: false },
          retryCount: 0,
          timestamp: new Date(),
        });
      }

      this.concert.history.push(record);
      previousOutputs.set(movement.id, record);

      this.checkProgramConstraints(movement, record);

      const transition = this.matchTransition(movement, achieved);
      currentId = transition?.to ?? '__fail__';
    }

    if (currentId === '__end__') {
      await this.finalize('completed');
    } else {
      await this.finalize('failed', 'Reached __fail__ terminal');
    }
  }

  private async handleExecutionError(err: unknown): Promise<void> {
    if (err instanceof ConstraintBreachError) {
      await this.store.pushEvent({
        type: 'constraint:breached',
        concertId: this.concert.id,
        constraint: err.constraint,
        limit: err.limit,
        actual: err.actual,
        timestamp: new Date(),
      });
      await this.finalize('failed', err.message);
    } else if (err instanceof OrchestronError) {
      await this.finalize('failed', err.message);
    } else {
      await this.finalize('failed', (err as Error).message ?? 'Unknown error');
    }
  }

  private async waitForResume(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pauseResolver = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
    });
  }

  private async finalize(status: 'completed' | 'failed' | 'cancelled', reason?: string): Promise<void> {
    this._status = status;
    this.concert.status = status;
    this.concert.completedAt = new Date();
    this.concert.currentMovement = null;

    await Promise.all(
      Array.from(this.activeSessions.entries()).map(([sessionId, adapter]) =>
        adapter.disposeSession?.(sessionId).catch(() => {}),
      ),
    );
    this.activeSessions.clear();

    await this.store.updateConcert({
      id: this.concert.id,
      status,
      completedAt: this.concert.completedAt,
      currentMovement: null,
      usage: this.concert.usage,
    });

    if (status === 'completed') {
      await this.store.pushEvent({
        type: 'concert:completed',
        concertId: this.concert.id,
        timestamp: new Date(),
      });
    } else if (status === 'cancelled') {
      await this.store.pushEvent({
        type: 'concert:cancelled',
        concertId: this.concert.id,
        timestamp: new Date(),
      });
    } else {
      await this.store.pushEvent({
        type: 'concert:failed',
        concertId: this.concert.id,
        error: { code: 'CONCERT_FAILED', message: reason ?? 'Unknown error', retryable: false, concertId: this.concert.id },
        timestamp: new Date(),
      });
    }
  }
}
