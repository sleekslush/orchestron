export const MICRO_DOLLARS_PER_DOLLAR = 1_000_000;

export function dollarsToMicro(dollars: number): number {
  return Math.round(dollars * MICRO_DOLLARS_PER_DOLLAR);
}

export function microToDollars(micro: number): number {
  return micro / MICRO_DOLLARS_PER_DOLLAR;
}
