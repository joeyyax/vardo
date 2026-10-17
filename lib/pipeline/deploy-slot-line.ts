// The deploy slots line on the Pipeline page.

import type { PipelineSnapshot } from "./types";

/** "5 of 8 running here, 1 more on Long House". A run on a target's deploy slot isn't one of this server's. */
export function deploySlotLine(s: Pick<PipelineSnapshot, "deploySlots" | "deploys">): string {
  const { busy, total, onTargets } = s.deploySlots;
  const here = `${busy} of ${total} running here`;
  if (onTargets === 0) return here;
  const names = new Set(s.deploys.filter((d) => d.status === "running" && d.claimSlot === "target").map((d) => d.builderName));
  const only = names.size === 1 ? [...names][0] : null;
  return `${here}, ${onTargets} more on ${only ?? "build targets"}`;
}
