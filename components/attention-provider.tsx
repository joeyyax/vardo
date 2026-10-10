"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { type AttentionRunner } from "@/components/attention-issues";
import { useFixRunner } from "@/components/fix-action";
import { useInfrastructureStatus } from "@/hooks/use-infrastructure-status";
import {
  attentionPanelKey,
  attentionPanelTarget,
  mergeAttentionRows,
  sameTarget,
  summarize,
  type AttentionRow,
  type AttentionTarget,
  type BarSummary,
  type GroupedItem,
} from "@/lib/ui/attention";

const POLL_MS = 60_000;

type AttentionContextValue = {
  rows: AttentionRow[];
  summary: BarSummary;
  /** False until the org's rows first arrive. */
  loaded: boolean;
  runner: AttentionRunner;
};

const AttentionContext = createContext<AttentionContextValue | null>(null);

/** One fetch of the org's attention rows, shared by the bar, the panel and the Projects stats. */
export function AttentionProvider({ orgId, children }: { orgId: string; children: ReactNode }) {
  const [orgRows, setOrgRows] = useState<AttentionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const inFlight = useRef(false);
  const infra = useInfrastructureStatus();
  const fixes = useFixRunner(orgId);

  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    fetch(`/api/v1/organizations/${orgId}/attention`)
      .then(async (res) => {
        if (!res.ok) return;
        setOrgRows((await res.json()).rows ?? []);
        setLoaded(true);
      })
      .catch(() => {
        // Keep the last known rows.
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [orgId]);

  // Refetch on navigation; the layout persists.
  useEffect(() => {
    load();
  }, [load, pathname]);

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && load();
    const interval = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  // Refresh once the server answers again after a self-deploy.
  useEffect(() => {
    if (infra.resolvedAt !== null) router.refresh();
  }, [infra.resolvedAt, router]);

  const rows = useMemo(() => mergeAttentionRows(infra.rows, orgRows), [infra.rows, orgRows]);
  const summary = useMemo(() => summarize(rows), [rows]);

  const { busy, run } = fixes;
  const runner = useMemo<AttentionRunner>(
    () => ({
      busy,
      run: (fix, name) => {
        void run({ id: fix.app.id, name: fix.app.name, displayName: name }, fix.run).then(load);
      },
      open: (item: GroupedItem) => {
        if (!item.href) return;
        if (item.external) window.open(item.href, "_blank", "noopener,noreferrer");
        else router.push(item.href);
      },
    }),
    [busy, run, load, router],
  );

  const value = useMemo(() => ({ rows, summary, loaded, runner }), [rows, summary, loaded, runner]);
  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useAttention(): AttentionContextValue {
  const value = useContext(AttentionContext);
  if (!value) throw new Error("useAttention needs an AttentionProvider");
  return value;
}

/** What the panel is open on, from ?panel=, and the controls that change it. Needs a Suspense boundary. */
export function useAttentionTarget() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const target = attentionPanelTarget(params.get("panel"));

  const set = useCallback(
    (next: AttentionTarget | null) => {
      const sp = new URLSearchParams(params.toString());
      sp.delete("app");
      if (next) sp.set("panel", attentionPanelKey(next));
      else sp.delete("panel");
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  /** Opens on a target, or closes when it is already open there. */
  const toggle = useCallback((next: AttentionTarget) => set(sameTarget(target, next) ? null : next), [set, target]);

  return { target, open: set, close: () => set(null), toggle };
}
