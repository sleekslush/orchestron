import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SqliteLoge } from '@orchestron/core';
import {
  CostResolver,
  OpenRouterPricing,
  convertPricingOverridesToLookup,
  loadConfigFile,
} from '@orchestron/core';

/** On-disk OpenRouter pricing cache so `list`/`status` work offline after a first fetch. */
export const PRICING_CACHE_PATH = join(homedir(), '.orchestron', 'pricing-cache.json');

/**
 * Resolve and persist estimated spend for all persisted movements/concerts
 * that currently carry tokens + model/provider but no spend. Used at read time
 * (CLI `list`/`status`) so reporting is never `unknown` when a pricing source
 * exists. Never blocks concert execution — it runs only on these read paths.
 */
export async function backfillSpend(store: SqliteLoge): Promise<void> {
  const config = loadConfigFile();
  const resolver = new CostResolver({
    openRouter: new OpenRouterPricing({ cachePath: PRICING_CACHE_PATH }),
    configTable: convertPricingOverridesToLookup(config?.pricing),
  });
  await store.backfillSpend((input) => resolver.resolveCost(input));
}
