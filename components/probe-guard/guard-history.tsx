"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RangePicker } from "@/components/range-picker";
import { BansList, type BanItem } from "@/components/probe-guard/bans-list";
import { GUARD_RANGES, parseGuardRange, rangeLabel, type GuardRange } from "@/lib/probe-guard/range";
import { categoryLine, type AppCategories, type RuleHit } from "@/lib/probe-guard/history-view";
import { guardSummaryParts, type GuardStatsView, type ProbeCount } from "@/lib/probe-guard/summary";

const PAGE = 50;

type HistoryData = {
  range: GuardRange;
  label: string;
  phrase: string;
  stats: GuardStatsView;
  bans: (BanItem & { appId: string | null })[];
  categories: ProbeCount[];
  rules: RuleHit[];
  probedNote: string | null;
  byApp: AppCategories[];
  sources: { ip: string; count: number; banned: boolean }[];
  note: string | null;
  appNames: Record<string, string>;
};

type Props = {
  /** The history endpoint; `?range=` is appended. */
  endpoint: string;
  banUrl: (id: string) => string;
  allowUrl?: string;
  canBanPermanently?: boolean;
  /** Admin view: app names on rows and the per-app split. */
  showApps?: boolean;
  /** Bumped by the page after a change elsewhere. */
  version?: number;
  onChange?: () => void;
};

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function HistoryView({ endpoint, banUrl, allowUrl, canBanPermanently = false, showApps = false, version = 0, onChange }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const range = parseGuardRange(params.get("range"));
  const [data, setData] = useState<HistoryData | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`${endpoint}?range=${range}`)
      .then((res) => (res.ok ? (res.json() as Promise<HistoryData>) : null))
      .catch(() => null)
      .then((body) => {
        if (live && body) setData(body);
      });
    return () => {
      live = false;
    };
  }, [endpoint, range, version, tick]);

  const setRange = useCallback(
    (next: GuardRange) => {
      const q = new URLSearchParams(params.toString());
      q.set("range", next);
      setShown(PAGE);
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const changed = () => {
    setTick((t) => t + 1);
    onChange?.();
  };

  const options = GUARD_RANGES.map((value) => ({ value, label: value === "all" && data?.range === "all" ? data.label : rangeLabel(value) }));
  const appName = (id: string | null) => (id ? data?.appNames[id] ?? null : null);

  return (
    <div className="space-y-4">
      <RangePicker options={options} value={range} onChange={setRange} label="Time range" />
      {!data ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {guardSummaryParts(data.stats, data.phrase).map((part, i) => (
                <span key={part.text}>
                  {i > 0 && ", "}
                  {part.target ? (
                    <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => scrollTo(part.target!)}>
                      {part.text}
                    </button>
                  ) : (
                    part.text
                  )}
                </span>
              ))}
            </p>
            {data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
          </div>

          <Section id="recent-bans" title="Recent bans">
            <BansList
              bans={data.bans.slice(0, shown).map((b) => ({ ...b, appName: showApps ? appName(b.appId) : null }))}
              banUrl={banUrl}
              onChange={changed}
              canBanPermanently={canBanPermanently}
              allowUrl={allowUrl}
              canBanAgain
              showCreated
              emptyText={`No bans ${data.phrase}.`}
            />
            {data.bans.length > shown && (
              <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            )}
          </Section>

          <Section id="probed" title="What was probed">
            {data.probedNote && <p className="text-xs text-muted-foreground">{data.probedNote}</p>}
            {data.categories.length === 0 ? (
              <p className="text-xs text-muted-foreground">No probe details {data.phrase}.</p>
            ) : (
              <>
                {showApps ? (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {data.rules.map((r) => (
                      <li key={r.label}>
                        <span className="font-medium text-foreground">{r.label}</span>
                        {" · "}
                        {r.hits.toLocaleString("en-US")} hit{r.hits === 1 ? "" : "s"}
                        {" · "}
                        {r.bans.toLocaleString("en-US")} ban{r.bans === 1 ? "" : "s"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{categoryLine(data.categories)}</p>
                )}
                {showApps && data.byApp.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {data.byApp.map((a) => (
                      <li key={a.appId ?? "none"}>
                        <span className="font-medium text-foreground">{appName(a.appId) ?? (a.appId ? "Deleted app" : "Console")}</span>
                        {" · "}
                        {categoryLine(a.categories, 4)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Section>

          <Section id="top-sources" title="Top sources">
            {data.sources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No probing addresses {data.phrase}.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {data.sources.map((s) => (
                  <li key={s.ip} className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm">
                    <span className="font-mono">{s.ip}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {s.count.toLocaleString("en-US")} probe{s.count === 1 ? "" : "s"} · {s.banned ? "Banned" : "Not banned"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

/** Counts, recent bans, what was probed and top sources for the range in `?range=`. */
export function GuardHistory(props: Props) {
  return (
    <Suspense fallback={<Loader2 className="size-4 animate-spin text-muted-foreground" />}>
      <HistoryView {...props} />
    </Suspense>
  );
}
