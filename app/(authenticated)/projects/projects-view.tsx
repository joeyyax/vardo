"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Keyboard, Search } from "lucide-react";
import { useAppMetrics } from "@/components/app-metrics-card";
import { DensityToggle, useDensity } from "@/components/density-toggle";
import { DetailPanel, DETAIL_PANEL_GUTTER } from "@/components/detail-panel";
import { useFixRunner } from "@/components/fix-action";
import { Stat, StatFilter, StatGroup } from "@/components/stat-filter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusMark } from "@/components/ui/status-dot";
import type { UiDensity } from "@/lib/db/schema/enums";
import { formatBytes, formatCoresShort } from "@/lib/metrics/format";
import {
  ancestry,
  buildSections,
  fleetCounts,
  isPanelKey,
  locate,
  matchesQuery,
  walk,
  PANEL_TITLE,
  type PanelKey,
  type ProjectsApp,
  type ProjectsProject,
  type Section,
  type TreeNode,
} from "@/lib/ui/projects";
import { cn } from "@/lib/utils";
import { ProjectList, usageOf, type ListContext } from "./project-list";
import { useImageUpdates } from "./updates-banner";
import { AppDetail, BackLink, OpenAppLink, PanelList, Where, type PanelContext } from "./projects-panel";
import { EntityLink } from "@/components/entity-link";
import { appHref } from "@/lib/ui/hrefs";
import { useAttention, useAttentionTarget } from "@/components/attention-provider";
import { ATTENTION_PANEL_ID } from "@/components/layout/attention-bar";
import { sameTarget, type AttentionTarget } from "@/lib/ui/attention";

// Container state can change outside Vardo; the reconciler polls every 60s, so faster gains nothing.
const REFRESH_MS = 60_000;

const PANEL_ID = "projects-panel";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}

/** Moves the list's one tabbable row. */
function focusRow(list: HTMLElement | null, el: HTMLElement | null) {
  if (!el) return;
  list?.querySelectorAll<HTMLElement>("[data-nav]").forEach((n) => (n.tabIndex = -1));
  el.tabIndex = 0;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
}

/** A modal or menu owns the keyboard while it is open. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]');
}

export function ProjectsView({
  orgId,
  apps,
  projects,
  initialDensity,
}: {
  orgId: string;
  apps: ProjectsApp[];
  projects: ProjectsProject[];
  initialDensity: UiDensity;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rawPanel = params.get("panel");
  const panel: PanelKey | null = isPanelKey(rawPanel) ? rawPanel : null;
  const selected = params.get("app");

  const [density, setDensity] = useDensity(initialDensity);
  const dense = density === "dense";
  const [query, setQuery] = useState("");
  const sections = useMemo(() => buildSections(projects, apps), [projects, apps]);
  const counts = useMemo(() => fleetCounts(sections), [sections]);

  // Healthy projects start as one calm line.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(sections.filter((s) => s.stats.issues === 0 && s.stats.deploying === 0 && s.nodes.length > 0).map((s) => s.project.id)),
  );
  const [openApps, setOpenApps] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);

  const { metrics, history, cpuCount } = useAppMetrics(orgId);
  const attention = useAttention();
  const { target: attentionTarget, toggle: toggleAttention } = useAttentionTarget();
  const { busy, run } = useFixRunner(orgId);
  const updates = useImageUpdates(orgId);
  const updatesByApp = useMemo(() => new Map((updates?.appsWithUpdates ?? []).map((a) => [a.id, a.count])), [updates]);

  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);

  const setUrl = useCallback(
    (next: { panel?: PanelKey | null; app?: string | null }) => {
      const sp = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value) sp.set(key, value);
        else sp.delete(key);
      }
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const filtering = query.trim().length > 0;
  const isProjectOpen = useCallback((id: string) => filtering || !collapsed.has(id), [collapsed, filtering]);
  const isAppOpen = useCallback(
    (node: TreeNode, section: Section) =>
      openApps.has(node.app.name) || (filtering && node.children.some((c) => matchesQuery(c, section.project, query))),
    [openApps, filtering, query],
  );

  const toggleProject = useCallback((id: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleApp = useCallback((name: string) => {
    setOpenApps((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /** Unfolds the project and parents an app sits in. */
  const reveal = useCallback(
    (name: string) => {
      const loc = locate(sections, name);
      if (!loc) return;
      const path = ancestry(sections, name);
      setCollapsed((s) => {
        const next = new Set(s);
        next.delete(loc.project.id);
        return next;
      });
      setShowAll((s) => new Set(s).add(loc.project.id));
      setOpenApps((s) => {
        const next = new Set(s);
        path.slice(0, -1).forEach((n) => next.add(n));
        return next;
      });
    },
    [sections],
  );

  const openApp = useCallback((name: string) => setUrl({ app: selected === name ? null : name }), [selected, setUrl]);

  /** From the panel: unfold, scroll to and highlight the row, then show the app. */
  const jump = useCallback(
    (name: string) => {
      reveal(name);
      setUrl({ app: name });
      setFlash(null);
      requestAnimationFrame(() => setFlash(name));
    },
    [reveal, setUrl],
  );

  useEffect(() => {
    if (!flash) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(flash)}"]`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    const id = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(id);
  }, [flash]);

  const openPanel = useCallback(
    (key: PanelKey) => setUrl(panel === key && !selected ? { panel: null, app: null } : { panel: key, app: null }),
    [panel, selected, setUrl],
  );

  const closePanel = useCallback(() => {
    const returnTo = selected && !panel ? selected : null;
    const stat = panel;
    setUrl({ panel: null, app: null });
    requestAnimationFrame(() => {
      if (returnTo) focusRow(listRef.current, listRef.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(returnTo)}"]`) ?? null);
      else if (stat) document.getElementById(`stat-${stat}`)?.focus();
    });
  }, [panel, selected, setUrl]);

  // The panel item to focus once the list renders again.
  const returnFocus = useRef<string | null>(null);

  const back = useCallback(() => {
    returnFocus.current = selected;
    setUrl({ app: null });
  }, [selected, setUrl]);

  // Focus moves into the panel when it opens or changes view.
  useEffect(() => {
    if (!panel && !selected) return;
    const id = requestAnimationFrame(() => {
      const root = panelRef.current;
      const from = returnFocus.current;
      returnFocus.current = null;
      const item = from && root?.querySelector<HTMLElement>(`[data-panel-item="${CSS.escape(from)}"]`);
      if (item) return item.focus();
      if (!root || root.contains(document.activeElement)) return;
      const target = selected
        ? root.querySelector<HTMLElement>("[data-back], button:not([aria-label='Close panel'])")
        : root.querySelector<HTMLElement>("[data-panel-item]");
      target?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [panel, selected]);

  const matches = useCallback((node: TreeNode, section: Section) => matchesQuery(node, section.project, query), [query]);
  const visible = useMemo(() => sections.filter((s) => s.nodes.length === 0 ? !filtering : s.nodes.some((n) => matchesQuery(n, s.project, query))), [sections, query, filtering]);

  // --- Keyboard -------------------------------------------------------------

  useEffect(() => {
    // One row is always reachable by Tab.
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-nav]");
    if (rows && rows.length && ![...rows].some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (overlayOpen() || keysOpen) return;
        if (isTyping(e.target)) {
          (e.target as HTMLElement).blur();
          return;
        }
        if (selected && panel) return back();
        if (selected || panel) {
          e.preventDefault();
          return closePanel();
        }
        return;
      }
      if (isTyping(e.target) || overlayOpen()) return;

      if (e.key === "/") {
        e.preventDefault();
        return searchRef.current?.focus();
      }
      if (e.key === "a") return toggleAttention("all");
      if (e.key === "d") return setDensity(dense ? "comfortable" : "dense");

      const active = document.activeElement as HTMLElement | null;
      const down = e.key === "ArrowDown" || e.key === "j";
      const up = e.key === "ArrowUp" || e.key === "k";

      if (panelRef.current?.contains(active) && (down || up)) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>("[data-panel-item]")];
        if (items.length) {
          e.preventDefault();
          const i = items.findIndex((el) => el === active || el.contains(active));
          const next = items[down ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
          next.focus();
          next.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      if (panelRef.current?.contains(active)) return;

      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
      const current = active?.closest<HTMLElement>("[data-nav]") ?? null;
      const i = current ? rows.indexOf(current) : -1;
      if (down) {
        e.preventDefault();
        return focusRow(listRef.current, rows[Math.min(rows.length - 1, i + 1)]);
      }
      if (up) {
        e.preventDefault();
        return focusRow(listRef.current, rows[Math.max(0, i - 1)]);
      }
      if (!current) return;
      const key = current.dataset.nav!;
      const projectId = key.startsWith("project:") ? key.slice(8) : null;
      const expanded = current.getAttribute("aria-expanded");

      if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        if (projectId && !isProjectOpen(projectId)) return toggleProject(projectId);
        if (!projectId && expanded === "false") return toggleApp(key);
        return focusRow(listRef.current, rows[i + 1] ?? null);
      }
      if (e.key === "ArrowLeft" || e.key === "h") {
        e.preventDefault();
        if (projectId && isProjectOpen(projectId)) return toggleProject(projectId);
        if (!projectId && expanded === "true" && openApps.has(key)) return toggleApp(key);
        if (projectId) return;
        const path = ancestry(sections, key);
        const loc = locate(sections, key);
        const parentKey = path.length > 1 ? path[path.length - 2] : loc ? `project:${loc.project.id}` : null;
        return focusRow(listRef.current, parentKey ? rows.find((r) => r.dataset.nav === parentKey) ?? null : null);
      }
      if (e.key === "Enter" && e.shiftKey) {
        if (active !== current) return;
        e.preventDefault();
        // Dense rows are links themselves.
        const link = current.matches("a[href]") ? current : current.querySelector<HTMLElement>("[data-row-link]");
        if (link instanceof HTMLAnchorElement) return router.push(link.getAttribute("href")!);
        return;
      }
      if (e.key === "Enter" || e.key === " " || e.key === "o") {
        if (active !== current) return;
        e.preventDefault();
        if (projectId) return toggleProject(projectId);
        return openApp(key);
      }
      if (e.key === "." && !projectId) {
        e.preventDefault();
        const trigger = current.querySelector<HTMLElement>("[data-row-menu]");
        trigger?.focus();
        trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [back, closePanel, dense, isProjectOpen, keysOpen, openApp, openApps, openPanel, panel, router, sections, selected, setDensity, toggleApp, toggleAttention, toggleProject]);

  // --- Render ---------------------------------------------------------------

  const listCtx: ListContext = {
    dense,
    query,
    selected,
    flash,
    isProjectOpen,
    isAppOpen,
    showsAll: (id) => showAll.has(id),
    toggleProject,
    toggleApp,
    showAll: (id) => setShowAll((s) => new Set(s).add(id)),
    open: openApp,
    busy,
    run,
    metrics,
    history,
    updatesByApp,
    matches,
  };

  const panelCtx: PanelContext = { orgId, sections, selected, busy, run, jump, open: openApp, metrics, history, cpuCount };

  const usage = sections
    .flatMap((s) => s.nodes)
    .map((n) => usageOf(n, metrics, history))
    .filter((u): u is NonNullable<typeof u> => !!u);
  const cpu = usage.reduce((n, u) => n + u.cpu, 0);
  const memory = usage.reduce((n, u) => n + u.memory, 0);

  const loc = selected ? locate(sections, selected) : null;
  const open = !!(panel || loc || attentionTarget);

  const stat = (key: PanelKey, value: ReactNode, label: string, tone?: string, unit?: ReactNode) => (
    <StatFilter
      id={`stat-${key}`}
      value={value}
      unit={unit}
      label={label}
      tone={tone}
      pressed={panel === key}
      controls={PANEL_ID}
      onPress={() => openPanel(key)}
    />
  );

  // Problems and routine notices open the shared attention panel, the same one the bar opens.
  const routine = attention.summary;
  const backups = new Set(routine.routine.find((g) => g.key === "backups")?.items.map((i) => i.subject)).size;
  const infoCount = (key: string) => routine.info.find((r) => r.key === key)?.items.length ?? 0;
  const updateCount = infoCount("image-updates");
  const unlimited = infoCount("no-memory-limit");
  const attentionStat = (t: AttentionTarget, value: number, label: string, tone?: string) => {
    const key = typeof t === "string" ? t : t.group;
    return (
      <StatFilter
        id={`stat-attention-${key}`}
        trigger={key}
        value={value}
        label={label}
        tone={tone}
        pressed={sameTarget(attentionTarget, t)}
        controls={ATTENTION_PANEL_ID}
        onPress={() => toggleAttention(t)}
      />
    );
  };

  return (
    <div
      data-density={density}
      data-healthy={dense ? undefined : "quiet"}
      className={cn("grid gap-9", open && DETAIL_PANEL_GUTTER)}
    >
      <StatGroup label="Open a list" active={!!(panel || attentionTarget)}>
        {stat("running", counts.running, "apps running", undefined, `of ${counts.apps}`)}
        {attention.loaded &&
          attentionStat("all", routine.routineFaults, routine.routineFaults === 1 ? "needs attention" : "need attention", routine.routineFaults ? "text-status-warning" : undefined)}
        {counts.deploying > 0 && stat("deploying", counts.deploying, "deploying now", "text-status-info")}
        {counts.stopped > 0 && stat("stopped", counts.stopped, "stopped")}
        {backups > 0 && attentionStat({ group: "backups" }, backups, backups === 1 ? "backup needs a look" : "backups need a look", "text-status-warning")}
        {updateCount > 0 && attentionStat({ group: "image-updates" }, updateCount, updateCount === 1 ? "image update" : "image updates")}
        {unlimited > 0 && attentionStat({ group: "no-memory-limit" }, unlimited, "without a memory limit")}
        {usage.length > 0 && (
          <>
            <Stat value={formatCoresShort(cpu)} unit={cpuCount ? `of ${cpuCount} cores` : "cores"} label="CPU in use" />
            <Stat value={formatBytes(memory)} label="memory in use" />
          </>
        )}
      </StatGroup>

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by app, project, domain or tag"
              aria-label="Filter apps"
              className="pr-8 pl-8"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-[5px] border px-1.5 font-mono text-[11px] text-muted-foreground/70">
              /
            </kbd>
          </div>
          {/* Both densities, so switching never adds or drops controls above the list. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCollapsed(new Set());
              setOpenApps(new Set(sections.flatMap((s) => walk(s.nodes)).filter((n) => n.children.length).map((n) => n.app.name)));
            }}
          >
            Expand all
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpenApps(new Set())}>
            Collapse all
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <DensityToggle value={density} onChange={setDensity} />
            <Popover open={keysOpen} onOpenChange={setKeysOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
                  <Keyboard />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-max max-w-[calc(100vw-32px)] gap-1.5 text-[12.5px] text-muted-foreground">
                <KeysHelp />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div ref={listRef}>
          {visible.length === 0 ? (
            <Card variant="surface" className="flex flex-wrap items-center justify-center gap-3 p-10 text-sm text-muted-foreground">
              No apps match “{query}”.
              <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                Clear the filter
              </Button>
            </Card>
          ) : (
            <ProjectList sections={visible} ctx={listCtx} />
          )}
        </div>
      </div>

      <DetailPanel
        ref={panelRef}
        open={open}
        onClose={closePanel}
        label={loc ? `${loc.node.app.displayName} details` : panel ? PANEL_TITLE[panel] : "Details"}
        eyebrow={
          loc ? (
            <>
              {panel && <BackLink panel={panel} onBack={back} />}
              <div className="text-[12.5px] text-muted-foreground">
                <Where loc={loc} />
              </div>
            </>
          ) : (
            <div className="text-[12.5px] text-muted-foreground">Projects</div>
          )
        }
        title={
          loc ? (
            <EntityLink href={appHref(loc.node.app.name)}>{loc.node.app.displayName}</EntityLink>
          ) : panel ? (
            PANEL_TITLE[panel]
          ) : (
            ""
          )
        }
        actions={loc ? <OpenAppLink name={loc.node.app.name} /> : undefined}
      >
        <div id={PANEL_ID} data-healthy="quiet" className="grid gap-5.5">
          {loc ? <AppDetail loc={loc} ctx={panelCtx} /> : panel ? <PanelList panel={panel} ctx={panelCtx} /> : null}
        </div>
      </DetailPanel>
    </div>
  );
}

function KeysHelp() {
  const k = "rounded-[5px] border border-b-2 px-1.5 font-mono text-[11px] text-foreground";
  return (
    <>
      <span>
        <kbd className={k}>j</kbd> <kbd className={k}>k</kbd> or arrows to move
      </span>
      <span>
        <kbd className={k}>→</kbd> <kbd className={k}>←</kbd> to expand and collapse
      </span>
      <span>
        <kbd className={k}>Enter</kbd> to open details, <kbd className={k}>.</kbd> for actions
      </span>
      <span>
        <kbd className={k}>Shift</kbd> <kbd className={k}>Enter</kbd> to go to the app or project page
      </span>
      <span>
        <kbd className={k}>/</kbd> to filter, <kbd className={k}>Esc</kbd> to close
      </span>
      <span>
        <kbd className={k}>a</kbd> for what needs attention, <kbd className={k}>d</kbd> to switch density
      </span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1">
        <StatusMark tone="good" />
        running
        <StatusMark tone="info" pending />
        deploying
        <StatusMark tone="warn" />
        attention
        <StatusMark tone="issue" />
        failed
        <StatusMark tone="stopped" />
        stopped
      </span>
    </>
  );
}
