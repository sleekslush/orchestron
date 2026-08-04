export interface EventFilter {
  types?: string[];
  limit?: number;
  since?: Date;
  order?: 'asc' | 'desc';
}

export interface SystemAggregates {
  totalConcerts: number;
  activeConcerts: number;
  /**
   * Aggregate spend in microdollars across all concerts (measured + estimated),
   * or undefined when no concert carries any spend.
   */
  totalSpend?: number;
  /** Portion of `totalSpend` derived from pricing estimates (microdollars). */
  estimatedSpend?: number;
  /** Portion of `totalSpend` that is harness-measured (microdollars). */
  measuredSpend?: number;
  totalTokens: number;
  avgDurationMs: number;
  failureRate: number;
}
