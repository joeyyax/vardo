"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/messenger";
import type { AppsSnapshot } from "@/lib/admin-apps/types";
import { cn } from "@/lib/utils";
import { AppsTable, Spark } from "./apps-table";
import { filterApps, groupApps, summarize, type GroupBy, type Sort, type SortKey } from "./table";

const SNAPSHOT_URL = "/api/v1/admin/apps";
const POLL_MS = 10_000;

/** The snapshot, refetched every few seconds unless paused. */
function useApps(paused: boolean): { snapshot: AppsSnapshot | null; live: boolean } {
  const [snapshot, setSnapshot] = useState<AppsSnapshot | null>(null);
  const [live, setLive] = useState(false);
  const warned = useRef(false);
  useEffect(() => {
    if (paused) return;
    let disposed = false;
    const load = () =>
      fetch(SNAPSHOT_URL)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as AppsSnapshot;
          if (disposed) return;
          setSnapshot(body);
          setLive(true);
          warned.current = false;
        })
        .catch(() => {
          if (disposed) return;
          setLive(false);
          if (!warned.current) toast.error("Couldn't load apps");
          warned.current = true;
        });
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [paused]);
  return { snapshot, live };
}

function Tile({ label, value, note, noteTone, children }: { label: string; value: string; note?: string; noteTone?: "issue" | null; children?: React.ReactNode }) {
  return (
    <Card variant="surface" className="flex min-w-0 flex-col px-3.5 py-3 shadow-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="mt-0.5 flex items-end justify-between gap-2">
        <span className="truncate whitespace-nowrap">
          <b className="text-xl font-semibold tracking-[-0.01em] tabular-nums">{value}</b>
          {note ? <small className={cn("ml-1 text-xs font-medium text-muted-foreground", noteTone === "issue" && "text-status-error")}>{note}</small> : null}
        </span>
        {children}
      </span>
    </Card>
  );
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

function Tiles({ s }: { s: AppsSnapshot }) {
  const t = s.totals;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {s.host ? (
        <Tile label={`${s.instanceName} memory`} value={gb(s.host.usedBytes)} note={`of ${gb(s.host.totalBytes)} GB`}>
          <span className="hidden sm:block">
            <Spark values={s.host.history} max={s.host.totalBytes} h={24} />
          </span>
        </Tile>
      ) : null}
      <Tile label="Deploys, 24 hours" value={String(t.deploys)} note={t.deploysFailed ? `${t.deploysFailed} failed` : t.deploys ? "all live" : undefined} noteTone={t.deploysFailed ? "issue" : null} />
      <Tile label="Backups, 24 hours" value={String(t.backups)} note={t.backupsFailed ? `${t.backupsFailed} failed` : t.backups ? "all good" : undefined} noteTone={t.backupsFailed ? "issue" : null} />
      {t.uptime !== null ? (
        <Tile
          label="Uptime, 24 hours"
          value={`${(Math.floor(t.uptime * 10000) / 100).toFixed(2)}%`}
          note={t.outages ? `${t.outages} ${t.outages === 1 ? "outage" : "outages"}` : "no outages"}
          noteTone={t.outages ? "issue" : null}
        />
      ) : null}
    </div>
  );
}

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "org", label: "Org" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];
const SORT_KEYS: SortKey[] = ["name", "cpu", "memory", "network", "uptime", "deploy"];

export function AppsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [paused, setPaused] = useState(false);
  const { snapshot, live } = useApps(paused);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  const groupParam = params.get("group") as GroupBy | null;
  const group: GroupBy = groupParam && GROUPS.some((g) => g.value === groupParam) ? groupParam : "org";
  const sortParam = params.get("sort");
  const sort = useMemo((): Sort => {
    const [key, dir] = (sortParam ?? "name:asc").split(":") as [SortKey, Sort["dir"]];
    return SORT_KEYS.includes(key) ? { key, dir: dir === "desc" ? "desc" : "asc" } : { key: "name", dir: "asc" };
  }, [sortParam]);
  const open = params.get("open");

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null) next.delete(key);
      else next.set(key, value);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => (snapshot ? groupApps(filterApps(snapshot.apps, filter), group, sort) : []), [snapshot, filter, group, sort]);

  if (!snapshot) {
    return (
      <div className="space-y-5">
        <h2 className="type-h2">Apps</h2>
        <Card variant="surface" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading apps…
        </Card>
      </div>
    );
  }

  const shown = groups.reduce((n, g) => n + g.apps.length, 0);
  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <h2 className="type-h2">Apps</h2>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {summarize(snapshot)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setFilter(""), e.currentTarget.blur())}
            placeholder="Filter apps"
            aria-label="Filter apps"
            className="h-9 w-52"
          />
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Group by</span>
            <Tabs value={group} onValueChange={(v) => setParam("group", v === "org" ? null : v)}>
              <TabsList aria-label="Group by">
                {GROUPS.map((g) => (
                  <TabsTrigger key={g.value} value={g.value} className="px-2.5 text-xs">
                    {g.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </span>
          <Button variant="outline" size="sm" aria-pressed={!paused} onClick={() => setPaused((p) => !p)} title={paused ? "Resume updates" : "Pause updates"}>
            <span aria-hidden className={cn("size-[7px] rounded-full", paused || !live ? "bg-status-warning" : "bg-status-success")} />
            {paused ? "Paused" : live ? "Live" : "Connecting"}
          </Button>
        </div>
      </div>

      <Tiles s={snapshot} />

      <Card variant="surface" className="overflow-x-auto pb-1.5">
        {shown === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {filter ? (
              <>
                No apps match “{filter}”.{" "}
                <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => setFilter("")}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No apps on this instance yet."
            )}
          </p>
        ) : (
          <AppsTable
            groups={groups}
            group={group}
            now={snapshot.at}
            sort={sort}
            onSort={(s) => setParam("sort", s.key === "name" && s.dir === "asc" ? null : `${s.key}:${s.dir}`)}
            open={open}
            onToggle={(id) => setParam("open", open === id ? null : id)}
          />
        )}
      </Card>
    </div>
  );
}
