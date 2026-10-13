import { tickRecaps } from "./tick";
import { IntervalLoop } from "@/lib/worker/interval-loop";

export const recapLoop = new IntervalLoop({
  name: "app-recaps",
  intervalMs: 5 * 60_000,
  run: () => tickRecaps(),
});
