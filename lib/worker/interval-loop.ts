import { isFeatureEnabled, type FeatureFlag } from "@/lib/config/features";
import { logger, type Logger } from "@/lib/logger";
import { closeOnShutdown } from "@/lib/shutdown";
import { instanceId } from "./instance";
import { recordTick } from "./jobs";
import { withFence } from "./fence";
import { LEASE_TTL_MS, acquireLease, leasesEnabled, releaseLease, type Lease } from "./lease";
import { logTickFailure, recordTickFailure, recordTickOk } from "./tick-failure";

export type LoopRole = "web" | "worker";

/** Handed to each pass. */
export type LoopContext = {
  /** False once the loop is stopping or lost its lease: a long pass returns at its next checkpoint. */
  readonly active: boolean;
  /** The lease this pass runs under; null for a non-singleton loop or with leases off. */
  readonly lease: Lease | null;
};

export type LoopOptions<T> = {
  name: string;
  /** Read before each wait, so a loop can speed up or back off. */
  intervalMs: number | (() => number);
  /** Wait before the first pass. Defaults to one interval, like setInterval. */
  firstRunMs?: number;
  /** "rate" keeps a fixed schedule and skips a slot while a pass runs; "delay" waits a full interval after each pass. */
  schedule?: "rate" | "delay";
  /** Scheduled passes start even while one is in flight, for passes that wait on long jobs. */
  overlap?: boolean;
  /** Runs once on start, before the first wait. False leaves the loop stopped. */
  prepare?: () => Promise<boolean | void>;
  run: (ctx: LoopContext) => Promise<T>;
  log?: Logger;
};

export type StartOptions = {
  role?: LoopRole;
  /** One process at a time, through a Postgres lease. */
  singleton?: boolean;
  /** Passes do nothing while this flag is off. */
  feature?: FeatureFlag;
  leaseTtlMs?: number;
};

/** How often a pass in flight refreshes its heartbeat. */
const BEAT_MS = 30_000;
/** Least time between recorded clean passes. */
const BEAT_GAP_MS = 15_000;

/**
 * A loop that wakes on an interval and does one pass: start and stop, a pass that a nudge joins,
 * a heartbeat per pass, a feature gate, and for singletons a lease taken before each pass and
 * renewed every TTL/3 while held.
 */
export class IntervalLoop<T = unknown> {
  readonly name: string;
  private readonly opts: LoopOptions<T>;
  private readonly log: Logger;

  private timer: NodeJS.Timeout | null = null;
  private scheduledMs = 0;
  private keepalive: NodeJS.Timeout | null = null;
  private inFlight: Promise<T | undefined> | null = null;
  private readonly overlapping = new Set<Promise<T | undefined>>();
  private beats: Promise<void> = Promise.resolve();
  private unregisterShutdown: (() => void) | null = null;

  private running = false;
  private stopping = false;
  private role: LoopRole = "web";
  private holder = "";
  private singleton = false;
  private feature: FeatureFlag | undefined;
  private leaseTtlMs = LEASE_TTL_MS;
  private lease: Lease | null = null;
  private leaseLost = false;
  private standby = false;
  private lastRenewOk = 0;
  private lastPassOk = false;
  private lastBeatAt = 0;

  constructor(opts: LoopOptions<T>) {
    this.name = opts.name;
    this.opts = opts;
    this.log = opts.log ?? logger.child(`loop:${opts.name}`);
  }

  get started(): boolean {
    return this.running;
  }

  /** A pass is running. */
  get busy(): boolean {
    return this.inFlight !== null || this.overlapping.size > 0;
  }

  start(options: StartOptions = {}): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.role = options.role ?? "web";
    this.holder = instanceId();
    this.singleton = options.singleton ?? false;
    this.feature = options.feature;
    this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.unregisterShutdown = closeOnShutdown(() => this.stop());
    void this.boot();
  }

  /** Stops the schedule, waits for passes in flight and hands the lease back. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unregisterShutdown?.();
    this.unregisterShutdown = null;
    await Promise.allSettled([this.inFlight, ...this.overlapping]);
    this.stopKeepalive();
    const lease = this.lease;
    this.lease = null;
    if (lease) await releaseLease(lease).catch(() => {});
    await this.beats;
  }

  /** Waits for queued heartbeat writes. */
  flush(): Promise<void> {
    return this.beats;
  }

  /** One pass now, or the pass already running. Undefined when skipped or failed. */
  tick(): Promise<T | undefined> {
    if (this.opts.overlap) {
      const pass = this.execute().finally(() => this.overlapping.delete(pass));
      this.overlapping.add(pass);
      return pass;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.execute().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private intervalMs(): number {
    const { intervalMs } = this.opts;
    return typeof intervalMs === "function" ? intervalMs() : intervalMs;
  }

  /** A standby retries the lease at least once per TTL, so it takes over soon after the holder stops. */
  private nextDelay(): number {
    const interval = this.intervalMs();
    return this.standby ? Math.min(interval, this.leaseTtlMs) : interval;
  }

  private async boot(): Promise<void> {
    if (this.opts.prepare) {
      try {
        if ((await this.opts.prepare()) === false) {
          await this.stop();
          return;
        }
      } catch (err) {
        this.log.error(`Loop ${this.name} setup failed:`, err);
      }
    }
    if (!this.running) return;
    this.schedule(this.opts.firstRunMs ?? this.intervalMs());
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledMs = ms;
    this.timer = setTimeout(() => void this.cycle(), ms);
    this.timer.unref?.();
  }

  private async cycle(): Promise<void> {
    if (!this.running) return;
    if (this.opts.schedule === "delay") {
      await this.tick();
      this.schedule(this.nextDelay());
      return;
    }
    // Skips this slot while a pass runs, like a guarded setInterval.
    this.schedule(this.nextDelay());
    if (this.opts.overlap || !this.inFlight) await this.tick();
    // This pass found the lease held elsewhere: retry within a TTL, not a full interval.
    if (this.standby && this.scheduledMs > this.leaseTtlMs) this.schedule(this.leaseTtlMs);
  }

  private queueBeat(write: () => Promise<unknown>): void {
    this.beats = this.beats.then(write).then(
      () => {},
      () => {},
    );
  }

  private async execute(): Promise<T | undefined> {
    const interval = this.intervalMs();
    const holder = this.holder || instanceId();
    // A clean pass right after a clean pass skips the write.
    const quiet = this.lastPassOk && Date.now() - this.lastBeatAt < BEAT_GAP_MS;
    const beatTick = () => this.queueBeat(() => recordTick(this.name, this.role, holder, interval));
    const beatOk = () => {
      this.lastPassOk = true;
      if (quiet) return;
      this.lastBeatAt = Date.now();
      this.queueBeat(() => recordTickOk(this.log, this.name));
    };

    if (this.feature && !isFeatureEnabled(this.feature)) {
      if (!quiet) beatTick();
      beatOk();
      return undefined;
    }

    const lease = await this.ensureLease();
    if (lease === false) return undefined;

    if (!quiet) beatTick();
    const beat = setInterval(beatTick, BEAT_MS);
    beat.unref?.();

    const active = () => !this.stopping && !this.leaseLost;
    const ctx: LoopContext = {
      get active() {
        return active();
      },
      lease,
    };
    try {
      const result = await withFence(lease, () => this.opts.run(ctx));
      beatOk();
      return result;
    } catch (err) {
      logTickFailure(this.log, this.name, err);
      this.lastPassOk = false;
      this.lastBeatAt = Date.now();
      this.queueBeat(() => recordTickFailure(this.log, this.name, err));
      return undefined;
    } finally {
      clearInterval(beat);
    }
  }

  /** The lease for this pass: null when none is needed, false while another process holds it. */
  private async ensureLease(): Promise<Lease | null | false> {
    if (!this.singleton || !leasesEnabled()) return null;
    if (this.stopping) return false;
    try {
      const lease = await acquireLease(this.name, this.leaseTtlMs, this.holder || instanceId());
      if (!lease) {
        this.dropLease();
        return false;
      }
      if (this.lease?.epoch !== lease.epoch) this.log.info(`Holding the ${this.name} lease (epoch ${lease.epoch})`);
      this.lease = lease;
      this.leaseLost = false;
      this.standby = false;
      this.lastRenewOk = Date.now();
      this.startKeepalive();
      // Stopped while the claim was in flight: stop() releases it, no pass runs.
      return this.stopping ? false : lease;
    } catch (err) {
      this.log.warn(`Couldn't take the ${this.name} lease, skipping this pass:`, err);
      if (this.lease && Date.now() - this.lastRenewOk >= this.leaseTtlMs) this.dropLease();
      return this.lease ?? false;
    }
  }

  private startKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => void this.renew(), Math.max(1, Math.floor(this.leaseTtlMs / 3)));
    this.keepalive.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private async renew(): Promise<void> {
    const held = this.lease;
    if (!held) return;
    try {
      const lease = await acquireLease(this.name, this.leaseTtlMs, held.holder);
      if (lease && lease.epoch === held.epoch) {
        this.lastRenewOk = Date.now();
        return;
      }
      this.dropLease();
    } catch {
      if (Date.now() - this.lastRenewOk >= this.leaseTtlMs) this.dropLease();
    }
  }

  private dropLease(): void {
    if (this.lease) {
      this.log.warn(`Lost the ${this.name} lease`);
      this.leaseLost = true;
    }
    this.lease = null;
    this.standby = true;
    this.stopKeepalive();
  }
}
