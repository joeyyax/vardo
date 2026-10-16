// Reruns the trust checks every 15 minutes while the page is on, and keeps the public routes in place.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { invalidatePublicTrust } from "./public-load";
import { runChecks } from "./run";
import { syncTrustRoutes } from "./route";
import { getTrustSettings } from "./store";
import { RUN_INTERVAL_MS } from "./types";

export const trustLoop = new IntervalLoop({
  name: "trust-checks",
  intervalMs: RUN_INTERVAL_MS,
  firstRunMs: 30_000,
  log: logger.child("trust"),
  run: async () => {
    const { visibility } = await getTrustSettings();
    if (visibility === "off") return;
    await runChecks();
    invalidatePublicTrust();
    if (visibility === "public") await syncTrustRoutes();
  },
});
