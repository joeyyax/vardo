"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyInfrastructureFailure,
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
  const [rows, setRows] = useState<AttentionRow[]>([]);
  const viewRef = useRef(view);
  const inFlight = useRef(false);

  viewRef.current = view;

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/v1/system/infrastructure", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const payload = await res.json();
      setView((state) =>
        applyInfrastructurePayload(
          state,
          { rows: payload.rows ?? [], selfDeploy: !!payload.selfDeploy },
          Date.now(),
        ),
      );
    } catch {
      setView(applyInfrastructureFailure);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // A hidden tab is not evidence of anything: no polls, so no failures either.
    const run = async () => {
      if (document.visibilityState === "visible") await check();
      if (!cancelled) timer = setTimeout(run, infrastructurePollMs(viewRef.current));
    };

    void run();

    const recheck = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("online", recheck);
    window.addEventListener(INFRA_RECHECK_EVENT, recheck);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("online", recheck);
      window.removeEventListener(INFRA_RECHECK_EVENT, recheck);
    };
  }, [check]);

  // Rendered rows are time-dependent — the resolved notice ages out on its own.
  useEffect(() => {
    setRows(infrastructureViewRows(view, Date.now()));
  }, [view]);

  return { rows, resolvedAt: view.resolvedAt };
}
