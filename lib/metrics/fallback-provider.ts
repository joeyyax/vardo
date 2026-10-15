// Reads the primary provider and falls back to a second one while the primary fails.

import { logger } from "@/lib/logger";
import type { MetricsProvider } from "./provider";
import type { ContainerMetrics } from "./types";

const log = logger.child("metrics-fallback");

/** How long a failed primary is skipped before it's tried again. */
export const PRIMARY_RETRY_MS = 60_000;

export class FallbackMetricsProvider implements MetricsProvider {
  private retryAt = 0;
  private failing = false;

  constructor(
    readonly primary: MetricsProvider,
    readonly fallback: MetricsProvider,
    private readonly opts: { retryMs?: number; now?: () => number } = {},
  ) {}

  get name(): string {
    return `${this.primary.name ?? "primary"} (fallback ${this.fallback.name ?? "secondary"})`;
  }

  /** The cadence of whichever source is serving. */
  get pollIntervalMs(): number | undefined {
    return this.failing ? this.fallback.pollIntervalMs : this.primary.pollIntervalMs;
  }

  /** True while the fallback is serving. */
  isFallingBack(): boolean {
    return this.failing;
  }

  async fetchAll(): Promise<ContainerMetrics[]> {
    const now = this.opts.now ?? Date.now;
    if (!this.failing || now() >= this.retryAt) {
      try {
        const metrics = await this.primary.fetchAll();
        if (this.failing) log.info(`${this.primary.name ?? "Primary"} recovered; metrics read from it again`);
        this.failing = false;
        return metrics;
      } catch (err) {
        if (!this.failing) {
          log.warn(
            `${this.primary.name ?? "Primary"} failed (${(err as Error).message}); reading ${this.fallback.name ?? "the fallback"} until it recovers`,
          );
        }
        this.failing = true;
        this.retryAt = now() + (this.opts.retryMs ?? PRIMARY_RETRY_MS);
      }
    }
    return this.fallback.fetchAll();
  }
}
