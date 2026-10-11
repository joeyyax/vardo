// Rewrites the guard file each minute, which drops expired bans and picks up domain changes, and prunes old records hourly.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { syncGuardFile } from "./sync";
import { pruneBans } from "./bans";
import { pruneEvents } from "./events";

const log = logger.child("probe-guard");

const INTERVAL_MS = 60_000;
const PRUNE_MS = 3_600_000;
let lastPrune = 0;

export const probeGuardLoop = new IntervalLoop({
  name: "probe-guard",
  intervalMs: INTERVAL_MS,
  firstRunMs: 0,
  log,
  run: async () => {
    await syncGuardFile();
    if (Date.now() - lastPrune >= PRUNE_MS) {
      lastPrune = Date.now();
      await pruneBans();
      await pruneEvents();
    }
  },
});
