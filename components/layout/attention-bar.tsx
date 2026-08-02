"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, ChevronDown } from "lucide-react";

import { AttentionRowList } from "@/components/attention-panel";
import { summarize, type AttentionRow, type AttentionTone } from "@/lib/ui/attention";

const POLL_MS = 60_000;

const ACCENT: Record<AttentionTone, string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  neutral: "text-muted-foreground",
};

const DOT: Record<AttentionTone, string> = {
  error: "bg-status-error",
  warning: "bg-status-warning",
  neutral: "bg-muted-foreground/50",
};

/**
 * Instance-wide notices as page chrome — one line under the nav on every page,
 * expanding in place. It sits outside the content column so the page title
 * never moves when the fleet changes.
 */
export function AttentionBar({ orgId }: { orgId: string }) {
  const [rows, setRows] = useState<AttentionRow[]>([]);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const inFlight = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/attention`);
      if (res.ok) setRows((await res.json()).rows ?? []);
    } catch {
      // Leave the last known rows up rather than blanking the bar on a blip.
    } finally {
      inFlight.current = false;
    }
  }, [orgId]);

  // Refetch on navigation too — the layout persists, so nothing else would.
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const summary = useMemo(() => summarize(rows), [rows]);

  // Close on the transition to healthy so the panel does not linger empty.
  useEffect(() => {
    if (summary.rows.length === 0) setOpen(false);
  }, [summary.rows.length]);

  if (summary.rows.length === 0) return null;

  const worst = summary.worst ?? "neutral";
  const headline =
    summary.faults === 0
      ? "Nothing needs attention"
      : `${summary.faults} thing${summary.faults === 1 ? "" : "s"} need${summary.faults === 1 ? "s" : ""} attention`;

  // Neutral ground on purpose. The bar sits on every page, and a permanent red
  // wash stops being read as an alarm within a day.
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="attention-detail"
        className="w-full border-b bg-muted/40 text-sm transition-colors hover:bg-muted/70"
      >
        <div className="container flex h-11 items-center gap-3">
          {summary.faults > 0 ? (
            <AlertTriangle aria-hidden="true" className={`size-4 shrink-0 ${ACCENT[worst]}`} />
          ) : (
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[worst]}`} />
          )}

          <span className="shrink-0 font-medium">{headline}</span>

          {/* Few enough to name: say which, so nobody expands to find one chip. */}
          {summary.subjects.length > 0 ? (
            <span className="min-w-0 truncate text-muted-foreground">
              {summary.subjects.map((s) => s.name).join(", ")}
            </span>
          ) : (
            <span className="hidden min-w-0 gap-x-3 truncate sm:flex">
              {summary.kinds.map((k) => (
                <span key={k.key} className={`shrink-0 ${ACCENT[k.tone]}`}>
                  {k.label}
                  <span className="ml-1 tabular-nums opacity-70">{k.count}</span>
                </span>
              ))}
            </span>
          )}

          <ChevronDown
            aria-hidden="true"
            className={`ml-auto size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {open && (
        <div
          id="attention-detail"
          className="absolute inset-x-0 top-full z-30 max-h-[70vh] overflow-y-auto border-b bg-card shadow-lg"
        >
          <div className="container py-1">
            <AttentionRowList rows={summary.rows} />
          </div>
        </div>
      )}
    </div>
  );
}
