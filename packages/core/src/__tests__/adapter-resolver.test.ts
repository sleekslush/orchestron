import { describe, it, expect } from 'vitest';
import { createAdapterResolver } from '../adapter-resolver.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';

const fakeAdapter = new FakeHarnessAdapter({ defaultResponse: { output: 'ok', summary: 'ok' } });

describe('createAdapterResolver', () => {
  it('returns adapter from a Map', async () => {
    const map = new Map([['fake', fakeAdapter]]);
    const resolver = createAdapterResolver(map);
    const adapter = await resolver.get('fake');
    expect(adapter).toBe(fakeAdapter);
  });

  it('throws ConductorPanic when harness type is missing from Map', async () => {
    const map = new Map<string, FakeHarnessAdapter>();
    const resolver = createAdapterResolver(map);
    await expect(resolver.get('missing')).rejects.toThrow(/No adapter registered for harness type 'missing'/);
  });

  it('delegates to a custom resolver', async () => {
    const custom = {
      get: async (name: string) => {
        if (name === 'custom') return fakeAdapter;
        throw new Error(`Unknown: ${name}`);
      },
    };
    const resolver = createAdapterResolver(custom);
    const adapter = await resolver.get('custom');
    expect(adapter).toBe(fakeAdapter);
  });

  it('passes concertId in error when provided with a Map', async () => {
    const map = new Map<string, FakeHarnessAdapter>();
    const resolver = createAdapterResolver(map);
    try {
      await resolver.get('missing', 'concert-123');
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const e = err as { concertId?: string };
      expect(e.concertId).toBe('concert-123');
    }
  });
});
