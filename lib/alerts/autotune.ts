// The alert held while the Auto profile has stopped raising an app's memory limit.

import type { Observation } from "@/lib/notifications/observations";

export function autotuneHaltObservation(halted: { appId: string; appName: string; raises: number; haltedAt: Date }): Observation {
  const about = `autotune:${halted.appId}`;
  return {
    type: "app.memory-limit",
    about,
    severity: "warning",
    fires: true,
    item: {
      type: "app.memory-limit",
      about,
      appId: halted.appId,
      appName: halted.appName,
      severity: "warning",
      title: `${halted.appName} keeps outgrowing its memory limit`,
      detail: `The Auto profile raised the limit ${halted.raises} times without it settling and has stopped.`,
      next: "Find what's growing, or set a limit yourself. Auto resumes once the limit changes.",
      since: halted.haltedAt.toISOString(),
    },
  };
}
