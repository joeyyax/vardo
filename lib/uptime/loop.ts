// Runs due uptime checks every ten seconds, rolls results up and keeps the automatic monitors in step with the apps.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { uptimeClient } from "./client";

export const uptimeLoop = new IntervalLoop({
  name: "uptime",
  intervalMs: 10_000,
  firstRunMs: 15_000,
  log: logger.child("uptime"),
  run: () => uptimeClient.tick(),
});
