// Keyed cooldowns for scheduled work: per host, provider or installation, in memory or shared through Redis.

import type Redis from "ioredis";
import { backoffDelay, type Jitter } from "./backoff";

export type CooldownEntry = { failures: number; until: number };

export interface CooldownStore {
  get(key: string): Promise<CooldownEntry | null>;
  set(key: string, entry: CooldownEntry, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCooldownStore implements CooldownStore {
  private entries = new Map<string, CooldownEntry & { expires: number }>();

  async get(key: string): Promise<CooldownEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expires) {
      this.entries.delete(key);
      return null;
    }
    return { failures: entry.failures, until: entry.until };
  }

  async set(key: string, entry: CooldownEntry, ttlMs: number): Promise<void> {
    this.entries.set(key, { ...entry, expires: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** Shares cooldowns across instances. Falls back to memory while Redis is unreachable. */
export class RedisCooldownStore implements CooldownStore {
  private fallback = new MemoryCooldownStore();

  constructor(
    private readonly client: Pick<Redis, "get" | "set" | "del">,
    private readonly prefix = "cooldown:",
  ) {}

  async get(key: string): Promise<CooldownEntry | null> {
    try {
      const raw = await this.client.get(this.prefix + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CooldownEntry>;
      return typeof parsed.failures === "number" && typeof parsed.until === "number"
        ? { failures: parsed.failures, until: parsed.until }
        : null;
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, entry: CooldownEntry, ttlMs: number): Promise<void> {
    try {
      await this.client.set(this.prefix + key, JSON.stringify(entry), "PX", Math.max(1, Math.ceil(ttlMs)));
    } catch {
      await this.fallback.set(key, entry, ttlMs);
    }
  }

  async delete(key: string): Promise<void> {
    await this.fallback.delete(key);
    try {
      await this.client.del(this.prefix + key);
    } catch {}
  }
}

export type CooldownOptions = {
  baseMs: number;
  maxMs: number;
  jitter?: Jitter;
  /** Ceiling on a server-requested hold. Defaults to `maxMs`. */
  maxHoldMs?: number;
  /** How long the failure count outlives the cooldown. */
  memoryMs?: number;
  store?: CooldownStore;
  random?: () => number;
};

/** Per-key backoff: failures stretch the wait, a server-requested hold can only extend it, success clears it. */
export class KeyedCooldown {
  private readonly store: CooldownStore;

  constructor(private readonly opts: CooldownOptions) {
    this.store = opts.store ?? new MemoryCooldownStore();
  }

  /** Milliseconds left on `key`'s cooldown; 0 when clear. */
  async remaining(key: string, now = Date.now()): Promise<number> {
    const entry = await this.store.get(key);
    return entry ? Math.max(0, entry.until - now) : 0;
  }

  async blocked(key: string, now = Date.now()): Promise<boolean> {
    return (await this.remaining(key, now)) > 0;
  }

  /** Records a failure and returns the wait it starts. `retryAfterMs` sets a floor under it. */
  async fail(key: string, opts: { baseMs?: number; retryAfterMs?: number | null; now?: number } = {}): Promise<number> {
    const now = opts.now ?? Date.now();
    const entry = await this.store.get(key);
    const failures = (entry?.failures ?? 0) + 1;
    const baseMs = opts.baseMs ?? this.opts.baseMs;
    let delay = backoffDelay(failures, {
      baseMs,
      maxMs: Math.max(baseMs, this.opts.maxMs),
      jitter: this.opts.jitter ?? "none",
      minMs: this.opts.jitter && this.opts.jitter !== "none" ? Math.min(baseMs, this.opts.maxMs) : 0,
      random: this.opts.random,
    });
    if (opts.retryAfterMs != null) delay = Math.max(delay, Math.min(opts.retryAfterMs, this.maxHold));
    await this.write(key, failures, Math.max(entry?.until ?? 0, now + delay), now);
    return delay;
  }

  /** Holds `key` for `ms` without counting a failure, as a rate-limit reset asks. Never shortens a longer hold. */
  async hold(key: string, ms: number, now = Date.now()): Promise<number> {
    const wait = Math.min(Math.max(0, ms), this.maxHold);
    const entry = await this.store.get(key);
    const until = Math.max(entry?.until ?? 0, now + wait);
    await this.write(key, entry?.failures ?? 0, until, now);
    return until - now;
  }

  async succeed(key: string): Promise<void> {
    await this.store.delete(key);
  }

  private get maxHold(): number {
    return this.opts.maxHoldMs ?? this.opts.maxMs;
  }

  private async write(key: string, failures: number, until: number, now: number): Promise<void> {
    const ttl = until - now + (this.opts.memoryMs ?? this.opts.maxMs);
    await this.store.set(key, { failures, until }, ttl);
  }
}
