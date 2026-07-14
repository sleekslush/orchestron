/**
 * Generic session pool that deduplicates concurrent session creation
 * and tracks active sessions for later disposal.
 */
export class SessionPool<T> {
  private sessions = new Map<string, T>();
  private sessionLocks = new Map<string, Promise<T>>();

  constructor(
    private readonly create: (sessionId: string) => Promise<T>,
    private readonly dispose?: (data: T) => Promise<void>,
  ) {}

  async getOrCreate(sessionId: string): Promise<T> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const inFlight = this.sessionLocks.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.create(sessionId)
      .then((data) => {
        this.sessions.set(sessionId, data);
        this.sessionLocks.delete(sessionId);
        return data;
      })
      .catch((err) => {
        this.sessionLocks.delete(sessionId);
        throw err;
      });

    this.sessionLocks.set(sessionId, promise);
    return promise;
  }

  get(sessionId: string): T | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const data = this.sessions.get(sessionId);
    if (!data) return;

    if (this.dispose) {
      await this.dispose(data).catch(() => {});
    }
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    const entries = Array.from(this.sessions.entries());
    this.sessions.clear();
    this.sessionLocks.clear();

    if (this.dispose) {
      await Promise.all(
        entries.map(async ([, data]) => {
          await this.dispose!(data).catch(() => {});
        }),
      );
    }
  }
}
