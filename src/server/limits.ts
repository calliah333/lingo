export class RateLimiter {
  private readonly entries = new Map<string, { failures: number; expiresAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  check(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) return { allowed: true, retryAfterMs: 0 };
    return entry.failures < this.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: entry.expiresAt - now };
  }

  fail(key: string, now: number): void {
    // Prune on writes, so inactive keys do not occupy the bounded map indefinitely.
    for (const [name, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(name);
    }
    const current = this.entries.get(key);
    if (current) {
      current.failures++;
      return;
    }
    if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { failures: 1, expiresAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}
