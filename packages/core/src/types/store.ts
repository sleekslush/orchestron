export interface EventFilter {
  types?: string[];
  limit?: number;
  since?: Date;
  order?: 'asc' | 'desc';
}

export interface SystemAggregates {
  totalConcerts: number;
  activeConcerts: number;
  /** Aggregate spend in microdollars, or undefined when no concert reports a cost. */
  totalSpend?: number;
  totalTokens: number;
  avgDurationMs: number;
  failureRate: number;
}
