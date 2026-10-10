"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronDown } from "lucide-react";

import { AttentionRowList } from "@/components/attention-panel";
import { AttentionIssueGroup, type AttentionRunner } from "@/components/attention-issues";
import { DetailPanel } from "@/components/detail-panel";
import { useFixRunner } from "@/components/fix-action";
import { AllClear } from "@/components/issue-group";
import { useInfrastructureStatus } from "@/hooks/use-infrastructure-status";
import {
  announceAttention,
  attentionPanelGroup,
  attentionPanelKey,
  mergeAttentionRows,
  summarize,
  type AttentionGroup,
  type AttentionRow,
  type AttentionTone,
  type GroupedItem,
} from "@/lib/ui/attention";
import { cn } from "@/lib/utils";

const POLL_MS = 60_000;

const ACCENT: Record<AttentionTone, string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  neutral: "text-muted-foreground",
  activity: "text-status-info",
};

const DOT: Record<AttentionTone, string> = {
  error: "bg-status-error",
  warning: "bg-status-warning",
  neutral: "bg-muted-foreground/50",
  activity: "bg-status-info",
};

/** A modal or menu owns the keyboard while it is open. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]');
}

/**
 * Notices bar under the nav on every page. One chip per problem group opens the triage panel;
 * the chevron expands everything in place, informational rows last.
 */
export function AttentionBar({ orgId }: { orgId: string }) {
  const [orgRows, setOrgRows] = useState<AttentionRow[]>([]);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const inFlight = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const infra = useInfrastructureStatus();
  const fixes = useFixRunner(orgId);

  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    fetch(`/api/v1/organizations/${orgId}/attention`)
      .then(async (res) => {
        if (res.ok) setOrgRows((await res.json()).rows ?? []);
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

  const rows = useMemo(() => mergeAttentionRows(infra.rows, orgRows), [infra.rows, orgRows]);
  const summary = useMemo(() => summarize(rows), [rows]);

  // Refresh once the server answers again after a self-deploy.
  useEffect(() => {
    if (infra.resolvedAt !== null) router.refresh();
  }, [infra.resolvedAt, router]);

  const empty = summary.groups.length === 0 && summary.info.length === 0;

  // Close once healthy.
  if (open && empty) setOpen(false);

  const runner: AttentionRunner = {
    busy: fixes.busy,
    run: (fix, name) => {
      void fixes.run({ id: fix.app.id, name: fix.app.name, displayName: name }, fix.run).then(load);
    },
    open: (item: GroupedItem) => {
      if (!item.href) return;
      setOpen(false);
      if (item.external) window.open(item.href, "_blank", "noopener,noreferrer");
      else router.push(item.href);
    },
  };

  const worst = summary.worst ?? "neutral";
  const headline =
    summary.faults === 0
      ? "Nothing needs attention"
      : `${summary.faults} thing${summary.faults === 1 ? "" : "s"} need${summary.faults === 1 ? "s" : ""} attention`;
  const toggle = () => setOpen((v) => !v);

  // Card, not muted: muted vanishes against the light-mode page background.
  return (
    <div ref={containerRef} className="relative">
      {/* Always mounted: a live region added with its content isn't announced. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announceAttention(rows)}
      </span>

      {!empty && (
        <div className="border-b bg-card text-sm">
          <div className="container flex h-11 items-center gap-3">
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-controls="attention-detail"
              className="flex shrink-0 items-center gap-3 rounded-md font-medium hover:text-foreground/80"
            >
              {summary.faults > 0 ? (
                <AlertTriangle aria-hidden="true" className={`size-4 shrink-0 ${ACCENT[worst]}`} />
              ) : (
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[worst]}`} />
              )}
              {headline}
            </button>

            <Suspense fallback={<ChipList groups={summary.groups} />}>
              <LinkedChips groups={summary.groups} />
            </Suspense>

            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-controls="attention-detail"
              aria-label={open ? "Hide details" : "Show details"}
              className="ml-auto flex min-w-0 shrink-0 items-center gap-3 rounded-md text-muted-foreground hover:text-foreground"
            >
              {summary.info.length > 0 && (
                <span className="hidden min-w-0 gap-x-3 truncate md:flex">
                  {summary.info.map((r) => (
                    <span key={r.key} className={cn("shrink-0", r.tone === "activity" && ACCENT.activity)}>
                      {r.label}
                      <span className="ml-1 tabular-nums opacity-70">{r.items.length}</span>
                    </span>
                  ))}
                </span>
              )}
              <ChevronDown
                aria-hidden="true"
                className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          </div>
        </div>
      )}

      {!empty && open && (
        <div
          id="attention-detail"
          className="absolute inset-x-0 top-full z-30 max-h-[70vh] overflow-y-auto bg-card shadow-lg dark:border-b"
        >
          <div className="container grid gap-6 py-4">
            {summary.groups.length > 0 && (
              <div className="grid items-start gap-6 lg:grid-cols-2">
                {summary.groups.map((g) => (
                  <AttentionIssueGroup key={g.key} group={g} runner={runner} />
                ))}
              </div>
            )}
            {summary.info.length > 0 && (
              <section className="grid gap-1.5">
                <h3 className="text-[13px] font-semibold text-muted-foreground">Also worth knowing</h3>
                <AttentionRowList rows={summary.info} />
              </section>
            )}
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        <AttentionTriagePanel groups={summary.groups} runner={runner} />
      </Suspense>
    </div>
  );
}

/** One chip per problem group, worst first. Without onOpen they render inert. */
function ChipList({
  groups,
  current = null,
  onOpen,
}: {
  groups: AttentionGroup[];
  current?: string | null;
  onOpen?: (key: string) => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-x-1 overflow-hidden">
      {groups.map((g, i) => (
        <button
          key={g.key}
          type="button"
          data-attention-group={g.key}
          aria-pressed={current === g.key}
          aria-controls="attention-panel"
          disabled={!onOpen}
          onClick={() => onOpen?.(g.key)}
          className={cn(
            "shrink-0 items-center rounded-md px-1.5 py-0.5 hover:bg-muted/60 aria-pressed:bg-muted",
            ACCENT[g.tone],
            i === 0 ? "inline-flex" : "hidden sm:inline-flex",
          )}
        >
          {g.title}
          <span className="ml-1 tabular-nums opacity-70">{g.items.length}</span>
        </button>
      ))}
    </span>
  );
}

/** Chips that open the triage panel through ?panel=. */
function LinkedChips({ groups }: { groups: AttentionGroup[] }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const current = attentionPanelGroup(params.get("panel"));

  const onOpen = (key: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("app");
    if (current === key) sp.delete("panel");
    else sp.set("panel", attentionPanelKey(key));
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return <ChipList groups={groups} current={current} onOpen={onOpen} />;
}

/** The triage panel a chip opens, on any page, scoped to one group. */
function AttentionTriagePanel({ groups, runner }: { groups: AttentionGroup[]; runner: AttentionRunner }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);
  const key = attentionPanelGroup(params.get("panel"));
  const group = key ? groups.find((g) => g.key === key) : undefined;
  const others = groups.filter((g) => g.key !== key);

  const setGroup = useCallback(
    (next: string | null) => {
      const sp = new URLSearchParams(params.toString());
      if (next) sp.set("panel", attentionPanelKey(next));
      else sp.delete("panel");
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const close = useCallback(() => {
    const from = key;
    setGroup(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-attention-group="${CSS.escape(from ?? "")}"]`)?.focus(),
    );
  }, [key, setGroup]);

  useEffect(() => {
    if (!key) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || overlayOpen()) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, close]);

  // Focus moves into the panel when it opens or changes group.
  useEffect(() => {
    if (!key) return;
    const id = requestAnimationFrame(() => {
      const root = panelRef.current;
      if (!root || root.contains(document.activeElement)) return;
      root.querySelector<HTMLElement>("[data-panel-item]")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [key]);

  const run: AttentionRunner = {
    ...runner,
    open: (item) => {
      if (!item.external) setGroup(null);
      runner.open(item);
    },
  };

  return (
    <DetailPanel
      ref={panelRef}
      open={!!key}
      onClose={close}
      label="Needs attention"
      title="Needs attention"
    >
      <div id="attention-panel" data-healthy="quiet" className="grid gap-5.5">
        {group ? (
          <AttentionIssueGroup group={group} runner={run} />
        ) : (
          <AllClear title="Nothing left here" detail="Every item in this group has cleared." />
        )}
        {others.length > 0 && (
          <section className="grid gap-1.5">
            <h3 className="text-[13px] font-semibold text-muted-foreground">Also needs attention</h3>
            <div className="flex flex-wrap gap-1.5">
              {others.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setGroup(g.key)}
                  className={cn("rounded-md bg-accent px-2 py-0.5 text-[13px] hover:bg-muted", ACCENT[g.tone])}
                >
                  {g.title}
                  <span className="ml-1 tabular-nums opacity-70">{g.items.length}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </DetailPanel>
  );
}
