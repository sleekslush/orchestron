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
import type { HarnessAdapter, ProgressUpdate } from '../types/adapter.js';
import type { Evaluator } from '../evaluator/evaluator.js';
import type { ConcertStore } from '../store/concert-store.js';
import { TraceService } from '../store/trace-service.js';
import type { ChildConcertFactory } from './child-concert-factory.js';
import type { IConductor } from './conductor-interface.js';
import type { StartOptions } from './start-options.js';
import {
  ConstraintBreachError,
  ConductorPanic,
  HarnessError,
  OrchestronError,
} from '../types/errors.js';
import { dollarsToMicro, microToDollars } from '../money.js';

export { StartOptions };

const DEFAULT_MOVEMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 5000; // 5 seconds

export class Conductor implements IConductor {
  private abortController = new AbortController();
  private pauseResolver: (() => void) | null = null;
  private _status: ConcertStatus = 'pending';
  private startedAt = 0;
  private nestingDepth: number;
  private activeSessions = new Map<string, HarnessAdapter>();
  private adapterResolver: { get(name: string): Promise<HarnessAdapter> };
  private loopPromise?: Promise<void>;
  private traceService?: TraceService;
  private movementVisitCount = new Map<MovementID, number>();
  private childConductors = new Map<ConcertID, IConductor>();

  constructor(
    private concert: Concert,
    private score: Score,
    private store: ConcertStore,
    private childFactory: ChildConcertFactory,
    adapters: Map<string, HarnessAdapter> | { get(name: string): Promise<HarnessAdapter> },
    private evaluator: Evaluator,
    tracesDir?: string,
    private defaultHarness?: string,
    private onFinalized?: (concertId: ConcertID) => void,
  ) {
    this._status = concert.status;
    this.nestingDepth = concert.nestingDepth ?? 0;
    if (tracesDir) {
      this.traceService = new TraceService(tracesDir, store);
    }
    this.adapterResolver =
      adapters instanceof Map
        ? {
            get: async (name) => {
              const adapter = adapters.get(name);
              if (!adapter) {
                throw new ConductorPanic(
                  `No adapter registered for harness type '${name}'`,
                  'INTERNAL_ERROR',
                  this.concert.id,
                );
              }
              return adapter;
            },
          }
        : adapters;
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
    this.concert.nestingDepth = this.nestingDepth;

    this.concert.status = 'running';
    this._status = 'running';
    this.startedAt = Date.now();
    await this.store.updateConcert({
      id: this.concert.id,
      status: 'running',
      context: this.concert.context,
      nestingDepth: this.nestingDepth,
    });
    await this.store.pushEvent({
      type: 'concert:started',
      concertId: this.concert.id,
      scoreId: this.score.id,
      timestamp: new Date(),
    });

    const signal = this.abortController.signal;
    const previousOutputs = new Map<MovementID, MovementRecord>();

    this.loopPromise = this.runLoop(this.score.startMovement, previousOutputs, 0, signal).catch(
      (err) => this.handleExecutionError(err),
    );
    await this.loopPromise;
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
    this.nestingDepth = this.concert.nestingDepth ?? (this.concert.parentConcertId ? 1 : 0);

    await this.store.updateConcert({ id: this.concert.id, status: 'running' });
    await this.store.pushEvent({
      type: 'concert:recovered',
      concertId: this.concert.id,
      timestamp: new Date(),
    });

    const signal = this.abortController.signal;
    let currentId: MovementID | '__end__' | '__fail__';
    let movementCount = this.concert.history.length;

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

        const transition = this.matchTransition(failedMovement, false);
        currentId = transition?.to ?? '__fail__';
      } else {
        currentId = '__fail__';
      }
    } else {
      currentId = this.score.startMovement;
    }

    const previousOutputs = this.buildPreviousOutputs();
    this.seedMovementVisitCounts();

    this.loopPromise = this.runLoop(currentId, previousOutputs, movementCount, signal).catch(
      (err) => this.handleExecutionError(err),
    );
    await this.loopPromise;
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

    // If there is no active execution loop (e.g. after process restart / rehydration),
    // continue execution from the stored current movement.
    if (!this.loopPromise) {
      const stored = await this.store.getConcert(this.concert.id);
      if (stored) {
        this.concert = stored;
      }
      if (this.startedAt === 0) {
        this.startedAt = this.concert.startedAt.getTime();
      }
      const signal = this.abortController.signal;
      const previousOutputs = this.buildPreviousOutputs();
      this.seedMovementVisitCounts();
      const currentId = this.concert.currentMovement ?? this.score.startMovement;
      this.loopPromise = this.runLoop(
        currentId,
        previousOutputs,
        this.concert.history.length,
        signal,
      ).catch((err) => this.handleExecutionError(err));
    }
  }

  async cancel(): Promise<void> {
    if (
      this._status !== 'pending' &&
      this._status !== 'running' &&
      this._status !== 'paused'
    ) {
      return;
    }

    this.abortController.abort();
    if (this._status === 'paused') {
      this.pauseResolver?.();
      this.pauseResolver = null;
    }

    // Propagate cancellation to child concerts.
    await Promise.all(
      Array.from(this.childConductors.values()).map((c) =>
        c.cancel().catch(() => {}),
      ),
    );

    // If there is no active execution loop (e.g. pending or rehydrated paused),
    // finalize immediately.
    if (!this.loopPromise) {
      await this.finalize('cancelled', 'Concert cancelled');
    }
  }

  async getState(): Promise<Concert> {
    return { ...this.concert };
  }

  private buildPreviousOutputs(): Map<MovementID, MovementRecord> {
    const previousOutputs = new Map<MovementID, MovementRecord>();
    for (const record of this.concert.history) {
      previousOutputs.set(record.movementId, record);
    }
    return previousOutputs;
  }

  private seedMovementVisitCounts(): void {
    for (const record of this.concert.history) {
      this.movementVisitCount.set(
        record.movementId,
        (this.movementVisitCount.get(record.movementId) ?? 0) + 1,
      );
    }
  }

  private async executeMovement(
    movement: Movement,
    previousOutputs: Map<MovementID, MovementRecord>,
    signal: AbortSignal,
  ): Promise<MovementRecord> {
    const startedAt = new Date();

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

    let harnessAdapter: HarnessAdapter | undefined;
    let sessionId: string | undefined;

    try {
      if (movement.subscore) {
        return await this.executeSubscore(movement, previousOutputs, signal, record);
      }

      harnessAdapter = await this.resolveAdapter(movement);
      const prompt = this.buildPrompt(movement, previousOutputs);
      this.movementVisitCount.set(
        movement.id,
        (this.movementVisitCount.get(movement.id) ?? 0) + 1,
      );
      const persistSession = this.score.program?.persistSession !== false;
      sessionId = persistSession ? `${this.concert.id}:${movement.id}` : undefined;

      if (sessionId) {
        this.activeSessions.set(sessionId, harnessAdapter);
      }

      await this.store.pushEvent({
        type: 'movement:started',
        concertId: this.concert.id,
        movementId: movement.id,
        prompt: prompt.slice(0, 5000),
        timestamp: startedAt,
      });

      const movementController = new AbortController();
      const movementSignal = movementController.signal;
      const onParentAbort = () => movementController.abort();
      if (signal.aborted) {
        movementController.abort();
      } else {
        signal.addEventListener('abort', onParentAbort, { once: true });
      }

      let timeoutMs: number | undefined;
      if (movement.budget?.timeoutMs && movement.budget.timeoutMs > 0) {
        timeoutMs = movement.budget.timeoutMs;
      } else if (this.score.program?.maxDurationMs && this.startedAt > 0) {
        const remaining = this.score.program!.maxDurationMs - (Date.now() - this.startedAt);
        if (remaining > 0) {
          timeoutMs = remaining;
        }
      }
      if (!timeoutMs) {
        timeoutMs = DEFAULT_MOVEMENT_TIMEOUT_MS;
      }
      const timeoutHandle = setTimeout(() => {
        movementController.abort();
      }, timeoutMs);

      const heartbeatHandle = setInterval(() => {
        const elapsedMs = Date.now() - startedAt.getTime();
        this.store.pushEvent({
          type: 'movement:progress',
          concertId: this.concert.id,
          movementId: movement.id,
          progressType: 'heartbeat',
          payload: {
            elapsedMs,
            message: `Movement '${movement.id}' still running (${Math.round(elapsedMs / 1000)}s)`,
          },
          timestamp: new Date(),
        }).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);

      const onProgress = (update: ProgressUpdate) => {
        if (update.type === 'usage_update') {
          this.store.updateConcert({
            id: this.concert.id,
            usage: update.usage,
          }).catch(() => {});
          return;
        }
        const payload: Record<string, unknown> = { type: update.type };
        if (update.type === 'tool_execution_start') {
          payload.toolName = update.toolName;
          if (update.args) payload.args = update.args;
        } else if (update.type === 'tool_execution_end') {
          payload.toolName = update.toolName;
          payload.isError = update.isError;
          if (update.result !== undefined) payload.result = update.result;
          if (update.error) payload.error = update.error;
        }
        this.store.pushEvent({
          type: 'movement:progress',
          concertId: this.concert.id,
          movementId: movement.id,
          progressType: update.type,
          payload,
          timestamp: new Date(),
        }).catch(() => {});
      };

      try {
        const response = await harnessAdapter.execute(prompt, this.concert.context, {
          signal: movementSignal,
          output: movement.output,
          movementId: movement.id,
          sessionId,
          model: movement.model,
          provider: movement.provider,
          onProgress,
        });

        record.status = 'completed';
        record.output = response.output;
        if (response.structured) record.structured = response.structured;
        record.summary = response.summary;
        record.usage = response.usage;
        if (response.model) record.model = response.model;
        if (response.provider) record.provider = response.provider;
        record.durationMs = Date.now() - startedAt.getTime();
      } finally {
        clearTimeout(timeoutHandle);
        clearInterval(heartbeatHandle);
        signal.removeEventListener('abort', onParentAbort);
      }
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

    if (this.traceService && harnessAdapter && sessionId) {
      const traceId = await this.traceService.recordFromAdapter(
        harnessAdapter,
        sessionId,
        this.concert.id,
        movement.id,
        record.status,
      );
      if (traceId) {
        record.traceId = traceId;
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

    const maxDepth = this.score.program?.maxNestingDepth ?? 5;
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

    const childConductor = await this.childFactory.createChildConcert(
      movement.subscore.scoreId,
      childOptions,
    );

    this.childConductors.set(childConductor.concertId, childConductor);
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

  private async resolveAdapter(movement: Movement): Promise<HarnessAdapter> {
    const type = movement.harness ?? this.concert.explicitHarness ?? this.defaultHarness;
    if (!type) {
      throw new ConductorPanic(
        `Movement '${movement.id}' has no harness specified and no default is configured`,
        'INTERNAL_ERROR',
        this.concert.id,
      );
    }
    const adapter = await this.adapterResolver.get(type);
    if (!adapter) {
      throw new ConductorPanic(
        `No adapter registered for harness type '${type}'`,
        'INTERNAL_ERROR',
        this.concert.id,
      );
    }
    return adapter;
  }

  private selectMovementPrompt(movement: Movement): string {
    if (!movement.prompt) return '';

    if (typeof movement.prompt === 'object') {
      const visits = this.movementVisitCount.get(movement.id) ?? 0;
      return visits === 0 ? movement.prompt.initial : movement.prompt.subsequent;
    }

    return movement.prompt;
  }

  private buildPrompt(
    movement: Movement,
    previousOutputs: Map<MovementID, MovementRecord>,
  ): string {
    const raw = this.selectMovementPrompt(movement);
    if (!raw) return '';

    // Structured output formatting/parsing is an adapter concern per the session-persistence
    // decision; the adapter injects the schema instructions and parses the result.
    return this.resolveTemplate(raw, movement.id, previousOutputs);
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
      this.score.program?.maxMovements ??
      this.score.program?.perSection?.['*']?.maxMovements ??
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

  private checkMovementConstraints(
    movement: Movement,
    record: MovementRecord,
  ): void {
    // Per-execution spend limit (in dollars; internal usage is micro-dollars).
    // This is checked against a single harness call (or subscore rollup), matching
    // the per-execution semantics of budget.timeoutMs.
    const movementMaxSpendMicro = movement.budget?.maxSpendDollars
      ? Math.round(movement.budget.maxSpendDollars * 1_000_000)
      : undefined;
    if (movementMaxSpendMicro && (record.usage.spend ?? 0) > movementMaxSpendMicro) {
      const movementSpendDollars = (record.usage.spend ?? 0) / 1_000_000;
      throw new ConstraintBreachError(
        `Movement spend limit exceeded: $${movementSpendDollars.toFixed(6)} > $${movement.budget!.maxSpendDollars!.toFixed(6)}`,
        'SPEND_LIMIT',
        movement.budget!.maxSpendDollars!,
        movementSpendDollars,
        'maxSpendDollars',
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
    const program = this.score.program ?? {};

    // Update aggregate usage before checking constraints so failures still report real spend.
    this.concert.usage.spend = totalSpend;
    this.concert.usage.tokens = totalTokens;

    // maxSpendDollars is configured in dollars; internal usage is tracked in micro-dollars.
    const maxSpendMicro = program.maxSpendDollars ? dollarsToMicro(program.maxSpendDollars) : undefined;
    if (maxSpendMicro && totalSpend > maxSpendMicro) {
      const totalSpendDollars = microToDollars(totalSpend);
      throw new ConstraintBreachError(
        `Spend limit exceeded: $${totalSpendDollars.toFixed(6)} > $${program.maxSpendDollars!.toFixed(6)}`,
        'SPEND_LIMIT',
        program.maxSpendDollars!,
        totalSpendDollars,
        'maxSpendDollars',
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

      // Enforce per-execution movement budget before retries, matching the
      // per-execution semantics of budget.timeoutMs.
      this.checkMovementConstraints(movement, record);

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

      await this.store.updateConcert({
        id: this.concert.id,
        usage: this.concert.usage,
      });

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

    if (status === 'failed' || status === 'cancelled') {
      await Promise.all(
        Array.from(this.childConductors.values()).map((c) =>
          c.cancel().catch(() => {}),
        ),
      );
    }

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

    this.childConductors.clear();
    this.onFinalized?.(this.concert.id);
  }
}
