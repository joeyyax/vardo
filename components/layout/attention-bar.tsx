"use client";

import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { AttentionRowList } from "@/components/attention-panel";
import { AttentionIssueGroup } from "@/components/attention-issues";
import { useAttention, useAttentionTarget } from "@/components/attention-provider";
import { DetailPanel } from "@/components/detail-panel";
import { AllClear } from "@/components/issue-group";
import { announceAttention, sameTarget, showsBar, type AttentionGroup, type AttentionTarget } from "@/lib/ui/attention";
import { cn } from "@/lib/utils";

/** The panel every attention trigger controls. */
export const ATTENTION_PANEL_ID = "attention-panel";

/** A modal or menu owns the keyboard while it is open. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]');
}

const triggerKey = (t: AttentionTarget) => (typeof t === "string" ? t : t.group);

/**
 * The strip under the nav. It renders only while something is broken right now: a headline that
 * opens the panel on everything and one chip per urgent group that opens it on that group.
 */
export function AttentionBar() {
  const { rows, summary } = useAttention();
  return (
    <div>
      {/* Always mounted: a live region added with its content isn't announced. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announceAttention(rows)}
      </span>
      {showsBar(summary) && (
        <Suspense fallback={<BarStrip groups={summary.urgent} count={summary.urgentFaults} />}>
          <LinkedBar />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <AttentionTriagePanel />
      </Suspense>
    </div>
  );
}

function LinkedBar() {
  const { summary } = useAttention();
  const { target, toggle } = useAttentionTarget();
  return <BarStrip groups={summary.urgent} count={summary.urgentFaults} target={target} onToggle={toggle} />;
}

/** One row of buttons. Without onToggle they render inert. */
function BarStrip({
  groups,
  count,
  target = null,
  onToggle,
}: {
  groups: AttentionGroup[];
  count: number;
  target?: AttentionTarget | null;
  onToggle?: (t: AttentionTarget) => void;
}) {
  const trigger = (t: AttentionTarget, className: string, children: ReactNode) => (
    <button
      type="button"
      data-attention-trigger={triggerKey(t)}
      aria-expanded={sameTarget(target, t)}
      aria-controls={ATTENTION_PANEL_ID}
      disabled={!onToggle}
      onClick={() => onToggle?.(t)}
      className={cn(
        "shrink-0 items-center rounded-md px-2 py-1 hover:bg-muted/60 aria-expanded:bg-muted focus-visible:outline-2 focus-visible:outline-brass",
        className,
      )}
    >
      {children}
    </button>
  );

  // Card, not muted: muted vanishes against the light-mode page background.
  return (
    <div className="border-b bg-card text-sm">
      <div className="container flex h-11 min-w-0 items-center gap-1 overflow-hidden">
        {trigger(
          "all",
          "-ml-2 inline-flex gap-2.5 font-medium",
          <>
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-status-error" />
            {count} {count === 1 ? "needs" : "need"} attention now
          </>,
        )}
        {groups.map((g, i) =>
          trigger(
            { group: g.key },
            cn(g.tone === "error" ? "text-status-error" : "text-status-warning", i === 0 ? "inline-flex" : "hidden sm:inline-flex"),
            <>
              {g.title}
              <span className="ml-1 tabular-nums opacity-70">{g.items.length}</span>
            </>,
          ),
        )}
      </div>
    </div>
  );
}

/** Urgent groups first, then routine ones, then what's worth knowing. Opens from the bar or the Projects stats. */
function AttentionTriagePanel() {
  const { summary, runner } = useAttention();
  const { target, close } = useAttentionTarget();
  const panelRef = useRef<HTMLDivElement>(null);
  const key = target ? triggerKey(target) : null;
  const focus = key && key !== "all" && key !== "info" ? key : null;

  const closeAndReturn = () => {
    const from = key;
    close();
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-attention-trigger="${CSS.escape(from ?? "")}"]`)?.focus(),
    );
  };

  useEffect(() => {
    if (!key) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || overlayOpen()) return;
      e.preventDefault();
      close();
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-attention-trigger="${CSS.escape(key)}"]`)?.focus(),
      );
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, close]);

  // Scroll to and focus the group or row the panel opened on.
  useEffect(() => {
    if (!key) return;
    const id = requestAnimationFrame(() => {
      const root = panelRef.current;
      if (!root) return;
      const spot = key === "all" ? root : root.querySelector<HTMLElement>(`[data-attention-target="${CSS.escape(key)}"]`);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (spot && spot !== root) spot.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      if (!root.contains(document.activeElement)) (spot ?? root).querySelector<HTMLElement>("[data-panel-item], a[href]")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [key]);

  const run = {
    ...runner,
    open: (item: Parameters<typeof runner.open>[0]) => {
      if (!item.external) close();
      runner.open(item);
    },
  };

  const block = (scope: string, g: AttentionGroup) => (
    <div
      key={`${scope}-${g.key}`}
      data-attention-target={g.key}
      className={cn("-m-2 scroll-mt-4 rounded-xl p-2 transition-colors", focus === g.key && "bg-brass-muted")}
    >
      <AttentionIssueGroup group={g} runner={run} />
    </div>
  );

  const nothing = summary.urgent.length === 0 && summary.routine.length === 0;

  return (
    <DetailPanel ref={panelRef} open={!!target} onClose={closeAndReturn} label="Needs attention" title="Needs attention">
      <div id={ATTENTION_PANEL_ID} data-healthy="quiet" className="grid gap-7">
        {summary.urgent.length > 0 && (
          <section className="grid gap-4">
            <h3 className="text-[13px] font-semibold text-status-error">Broken now</h3>
            {summary.urgent.map((g) => block("urgent", g))}
          </section>
        )}
        {summary.routine.length > 0 && (
          <section className="grid gap-4">
            {summary.urgent.length > 0 && <h3 className="text-[13px] font-semibold text-muted-foreground">When you have a moment</h3>}
            {summary.routine.map((g) => block("routine", g))}
          </section>
        )}
        {nothing && <AllClear title="Nothing needs attention" detail="Every app is running as expected." />}
        {summary.info.length > 0 && (
          <section data-attention-target="info" className="grid scroll-mt-4 gap-1.5">
            <h3 className="text-[13px] font-semibold text-muted-foreground">Also worth knowing</h3>
            <AttentionRowList rows={summary.info} highlight={focus} />
          </section>
        )}
      </div>
    </DetailPanel>
  );
}
