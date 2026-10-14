import {
  sweepExpiredLeases,
  sweepGroupJobs,
  sweepQueuedDeployments,
  sweepStuckDeployments,
  sweepRollbackWatches,
  sweepStandbySlots,
} from "./sweeper";
import { sweepDeployStreams } from "@/lib/stream/deploy-expiry";
import { IntervalLoop } from "@/lib/worker/interval-loop";

/** Shorter than the main sweep; the default grace period is 60s. */
const ROLLBACK_INTERVAL_MS = 15_000;

const STANDBY_INTERVAL_MS = 5 * 60_000;

const STREAM_EXPIRY_INTERVAL_MS = 60 * 60_000;

// Every 15 seconds: a lease lapses 45 seconds after its executor stops.
export const deploySweepLoop = new IntervalLoop({
  name: "deploy-sweep",
  intervalMs: 15_000,
  run: async () => {
    await sweepExpiredLeases();
    await sweepGroupJobs();
    await sweepStuckDeployments();
    await sweepQueuedDeployments();
  },
});

export const rollbackWatchLoop = new IntervalLoop({
  name: "rollback-watch",
  intervalMs: ROLLBACK_INTERVAL_MS,
  run: () => sweepRollbackWatches(),
});

export const standbySweepLoop = new IntervalLoop({
  name: "standby-sweep",
  intervalMs: STANDBY_INTERVAL_MS,
  run: () => sweepStandbySlots(),
});

// The first pass at start catches streams left without an expiry.
export const deployStreamExpiryLoop = new IntervalLoop({
  name: "deploy-stream-expiry",
  intervalMs: STREAM_EXPIRY_INTERVAL_MS,
  firstRunMs: 0,
  run: () => sweepDeployStreams(),
});
