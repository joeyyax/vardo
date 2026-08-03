"use client";

import { useEffect, useState } from "react";

import type { RestartReading } from "@/lib/ui/stability";

/**
 * Live restart counter for an app's containers, or null while it is unread.
 * The header and the stability tab both read it — the verdict is wrong without
 * it, so neither may render the verdict without asking.
 */
export function useRestartReading(orgId: string, appId: string): RestartReading | null {
  const [restarts, setRestarts] = useState<RestartReading | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/apps/${appId}/stability`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { restarts: RestartReading | null } | null) => {
        if (!cancelled && data) setRestarts(data.restarts);
      })
      .catch(() => { /* best-effort — the caption says when it is missing */ });
    return () => { cancelled = true; };
  }, [orgId, appId]);

  return restarts;
}
