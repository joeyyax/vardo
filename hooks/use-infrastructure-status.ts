"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyInfrastructureFailure,
  applyInfrastructureThrottle,
  applyInfrastructurePayload,
  INFRA_RECHECK_EVENT,
  infrastructurePollMs,
  infrastructureViewRows,
  initialInfrastructureView,
  type InfrastructureView,
} from "@/lib/attention/infrastructure-view";
import type { AttentionRow } from "@/lib/ui/attention";

/**
 * Instance infrastructure, polled outside org scope. Cadence follows the state
 * machine — idle when there is nothing happening, fast while a deploy or an
 * outage is in play — and bus events from the current org bring a check
 * forward so a locally triggered deploy shows up immediately.
 */
export function useInfrastructureStatus(): { rows: AttentionRow[]; resolvedAt: number | null } {
  const [view, setView] = useState<InfrastructureView>(initialInfrastructureView);
  const [checkedAt, setCheckedAt] = useState(0);
  const [hiddenTick, setHiddenTick] = useState(0);
  const inFlight = useRef(false);

  const check = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    fetch("/api/v1/system/infrastructure", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 429) {
          const seconds = Number(res.headers.get("Retry-After"));
          setView((state) =>
            applyInfrastructureThrottle(state, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null),
          );
          setCheckedAt(Date.now());
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const payload = await res.json();
        const at = Date.now();
        setView((state) =>
          applyInfrastructurePayload(
            state,
            { rows: payload.rows ?? [], selfDeploy: !!payload.selfDeploy },
            at,
          ),
        );
        setCheckedAt(at);
      })
      .catch(() => {
        setView(applyInfrastructureFailure);
        setCheckedAt(Date.now());
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  // A hidden tab is not evidence of anything: no polls, so no failures either.
  useEffect(() => {
    if (document.visibilityState === "visible") check();

    const recheck = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("online", recheck);
    window.addEventListener(INFRA_RECHECK_EVENT, recheck);

    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("online", recheck);
      window.removeEventListener(INFRA_RECHECK_EVENT, recheck);
    };
  }, [check]);

  // Every check commits a new view, which re-arms this timer at that view's cadence.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") check();
      else setHiddenTick((n) => n + 1);
    }, infrastructurePollMs(view));
    return () => clearTimeout(timer);
  }, [view, hiddenTick, check]);

  // Rendered rows are time-dependent — the resolved notice ages out on its own.
  const rows = useMemo(() => infrastructureViewRows(view, checkedAt), [view, checkedAt]);

  return { rows, resolvedAt: view.resolvedAt };
}
