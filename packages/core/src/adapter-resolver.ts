import type { HarnessAdapter } from './types/adapter.js';
import { ConductorPanic } from './types/errors.js';
import type { ConcertID } from './types/concert.js';

/**
 * Minimal interface for resolving an adapter by harness type.
 */
export interface AdapterResolver {
  get(name: string, concertId?: ConcertID): Promise<HarnessAdapter>;
}

type AdapterSource =
  | Map<string, HarnessAdapter>
  | { get(name: string): Promise<HarnessAdapter> }
  | { resolve(name: string): Promise<HarnessAdapter> };

/**
 * Normalize a `Map | { get } | { resolve }` into a consistent
 * {@link AdapterResolver}.  When a plain `Map` is provided the returned
 * resolver looks up entries and throws a {@link ConductorPanic} when a
 * harness type is not registered.
 */
export function createAdapterResolver(adapters: AdapterSource): AdapterResolver {
  if (adapters instanceof Map) {
    return {
      get: async (name, concertId) => {
        const adapter = adapters.get(name);
        if (!adapter) {
          throw new ConductorPanic(
            `No adapter registered for harness type '${name}'`,
            'INTERNAL_ERROR',
            concertId,
          );
        }
        return adapter;
      },
    };
  }

  if ('resolve' in adapters) {
    return {
      get: adapters.resolve.bind(adapters) as (name: string) => Promise<HarnessAdapter>,
    };
  }

  return {
    get: async (name, _concertId) => adapters.get(name),
  };
}
