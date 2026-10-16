// Reruns the trust checks every 15 minutes while the page is on.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { runChecks } from "./run";
import { getTrustSettings } from "./store";
import { RUN_INTERVAL_MS } from "./types";

export const trustLoop = new IntervalLoop({
  name: "trust-checks",
  intervalMs: RUN_INTERVAL_MS,
  firstRunMs: 30_000,
  log: logger.child("trust"),
  run: async () => {
    if ((await getTrustSettings()).visibility === "off") return;
    await runChecks();
  },
});
