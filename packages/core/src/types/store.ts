export interface EventFilter {
  types?: string[];
  limit?: number;
  since?: Date;
}

export interface SystemAggregates {
  totalConcerts: number;
  activeConcerts: number;
  totalSpend: number;
  totalTokens: number;
  avgDurationMs: number;
  failureRate: number;
}
