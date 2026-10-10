import { tickDigestJobs } from "./tick";
import { IntervalLoop } from "@/lib/worker/interval-loop";

export const digestLoop = new IntervalLoop({
  name: "digest",
  intervalMs: 60_000,
  run: () => tickDigestJobs(),
});
