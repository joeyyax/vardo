"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { groupNotable } from "@/lib/away/group";
import { kindLabel, REASON_TONE } from "@/lib/away/labels";
import type { AwayNotable, AwayReason, AwaySummary } from "@/lib/away/types";

/** Kinds named before the rest are counted. */
const NAMED_KINDS = 2;

const TONE_TEXT: Record<"error" | "warning" | "neutral", string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  neutral: "text-muted-foreground",
};

type WireSummary = Omit<AwaySummary, "since" | "now" | "notable"> & {
  since: string;
  now: string;
  notable: (Omit<AwayNotable, "firstAt" | "lastAt"> & {
    firstAt: string;
    lastAt: string;
  })[];
};

type Tone = "error" | "warning" | "neutral";

const RANK: Tone[] = ["neutral", "warning", "error"];

/** Kinds with their subject totals, worst tone first. */
function summarize(summary: WireSummary): { kind: string; count: number; tone: Tone }[] {
  const tally = new Map<string, { kind: string; count: number; tone: Tone }>();
  for (const group of groupNotable(summary.notable)) {
    const tone = REASON_TONE[group.reason as AwayReason];
    const existing = tally.get(group.kind);
    if (existing) {
      existing.count += group.items.length;
      if (RANK.indexOf(tone) > RANK.indexOf(existing.tone)) existing.tone = tone;
      continue;
    }
    tally.set(group.kind, { kind: group.kind, count: group.items.length, tone });
  }
  return [...tally.values()].sort((a, b) => RANK.indexOf(b.tone) - RANK.indexOf(a.tone));
}

/**
 * What needed attention while the user was away, as a dismissible toast rather
 * than a band across the top of every page. Opening it hands off to activity,
 * filtered to the same window, instead of duplicating that view here.
 */
export function AwayToast({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [summary, setSummary] = useState<WireSummary | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/organizations/${orgId}/away-summary`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSummary(data?.summary ?? null))
      .catch(() => {
        // A summary that cannot load is not worth reporting on.
      });
    return () => controller.abort();
  }, [orgId]);

  function dismiss() {
    setSummary(null);
    fetch(`/api/v1/organizations/${orgId}/away-summary`, { method: "POST" }).catch(() => {});
  }

  function open() {
    router.push(`/activity?since=${encodeURIComponent(summary!.since)}`);
    dismiss();
  }

  if (!summary || summary.notable.length === 0) return null;

  const kinds = summarize(summary);
  const named = kinds.slice(0, NAMED_KINDS);
  const rest = kinds.slice(NAMED_KINDS).reduce((n, k) => n + k.count, 0);
  const worst = kinds[0]?.tone ?? "neutral";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))]"
    >
      <div
        className={`squircle flex items-start gap-3 rounded-lg border bg-card p-3 shadow-lg ${
          worst === "error" ? "border-status-error/40" : "border-border"
        }`}
      >
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 text-left transition-opacity hover:opacity-80"
        >
          {/* Worded as a delta, not a status count — the attention panel owns
              current state, and two different totals for "what is wrong" read
              as a contradiction. */}
          <span className="type-body block font-medium text-foreground">
            {summary.notable.length === 1
              ? "1 thing happened while you were away"
              : `${summary.notable.length} things happened while you were away`}
          </span>
          <span className="type-body-sm mt-0.5 block truncate text-muted-foreground">
            {named.map((k, i) => (
              <span key={k.kind}>
                {i > 0 && <span className="text-muted-foreground/40"> · </span>}
                <span className={TONE_TEXT[k.tone]}>{kindLabel(k.kind)}</span>
                {k.count > 1 && ` (${k.count})`}
              </span>
            ))}
            {rest > 0 && <span className="text-muted-foreground/70"> · {rest} more</span>}
          </span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss summary"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
