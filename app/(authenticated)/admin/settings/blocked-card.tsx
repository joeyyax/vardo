"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BlockedSummary, SourceBlocks } from "@/lib/probe-guard/blocked";

const ENDPOINT = "/api/v1/admin/probe-guard/blocked";

type BlockedData = BlockedSummary & {
  enabled: { abuseipdb: boolean; spamhaus: boolean };
  listed: { abuseipdb: number; spamhaus: number };
};

const LABELS: Record<string, string> = { local: "Your bans", abuseipdb: "AbuseIPDB", spamhaus: "Spamhaus DROP" };

const n = (v: number) => v.toLocaleString("en-US");

function DailyBars({ daily, days }: { daily: number[]; days: string[] }) {
  const max = Math.max(1, ...daily);
  return (
    <div className="flex h-8 items-end gap-px" aria-hidden>
      {daily.map((count, i) => (
        <div
          key={days[i]}
          title={`${days[i]}: ${n(count)}`}
          className={count > 0 ? "flex-1 rounded-[1px] bg-primary/70" : "flex-1 rounded-[1px] bg-muted"}
          style={{ height: count > 0 ? `${Math.max(8, (count / max) * 100)}%` : "2px" }}
        />
      ))}
    </div>
  );
}

function coverage(s: SourceBlocks, data: BlockedData): string | null {
  if (s.source === "abuseipdb" && data.listed.abuseipdb > 0) return `${n(s.uniqueIps)} of ${n(data.listed.abuseipdb)} listed addresses seen`;
  if (s.source === "spamhaus" && data.listed.spamhaus > 0) return `${n(data.rangesHit)} of ${n(data.listed.spamhaus)} ranges hit`;
  return null;
}

function SourceRow({ s, data }: { s: SourceBlocks; data: BlockedData }) {
  const off = s.source !== "local" && !data.enabled[s.source as "abuseipdb" | "spamhaus"];
  const extra = coverage(s, data);
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">
          {LABELS[s.source]}
          {off && <span className="ml-2 text-xs font-normal text-muted-foreground">Off</span>}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {n(s.today)} today · {n(s.week)} 7d · {n(s.month)} 30d · {n(s.uniqueIps)} {s.uniqueIps === 1 ? "IP" : "IPs"}
        </p>
      </div>
      <DailyBars daily={s.daily} days={data.days} />
      {extra && <p className="text-xs text-muted-foreground">{extra}, last 30 days</p>}
    </li>
  );
}

/** Requests each ban source turned away, per day over 30 days. */
export function BlockedCard({ version = 0 }: { version?: number }) {
  const [data, setData] = useState<BlockedData | null>(null);

  useEffect(() => {
    let live = true;
    fetch(ENDPOINT)
      .then((res) => (res.ok ? (res.json() as Promise<BlockedData>) : null))
      .then((body) => {
        if (live && body) setData(body);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);

  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Blocked requests</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y">
          {data.sources.map((s) => (
            <SourceRow key={s.source} s={s} data={data} />
          ))}
        </ul>
        {data.other > 0 && (
          <p className="text-xs text-muted-foreground">{n(data.other)} more matched a ban lifted or a header Vardo doesn&apos;t trust.</p>
        )}
      </CardContent>
    </Card>
  );
}
