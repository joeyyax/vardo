// The page's payload, built from settings and the latest results.

import { computeScore, countStates, dailyLast, historyChanges, nextSteps } from "./score";
import { findProvider, judgeProviderCert, locationLabel } from "./hosting";
import { effectiveHosting, getTrustSettings, providerLabel, readHistory, readResults } from "./store";
import { BANDS, CHECKS, type Band, type CheckState } from "./types";

export type TrustView = {
  visibility: "off" | "private";
  hostingOverride: { provider: string; region: string } | null;
  hosting: {
    provider: string;
    region: string | null;
    source: "detected" | "manual";
    certification: { standard: string; number: string | null; url: string; state: CheckState; evidence: string } | null;
  } | null;
  checks: { id: string; weight: number; earned: number; title: string; state: CheckState; evidence: string; checkedAt: string | null }[];
  score: { score: number; max: number; unverified: number; band: Band | null; bandLabel: string | null; bands: { band: Band; label: string; at: number }[] };
  counts: Record<CheckState, number>;
  steps: { id: string; gain: number; fix: string; effort: string; href: string; action: string; state: CheckState; evidence: string }[];
  history: { days: { day: string; score: number; max: number }[]; changes: { at: string; text: string }[] };
  lastRunAt: string | null;
};

const titleOf = (id: string) => CHECKS.find((c) => c.id === id)?.title ?? id;

export async function buildTrustView(): Promise<TrustView> {
  const [settings, results, runs] = await Promise.all([getTrustSettings(), readResults(), readHistory()]);
  const score = computeScore(results);
  const hosting = effectiveHosting(settings);
  const provider = hosting ? findProvider(hosting.provider) : null;
  const lastRun = results.reduce<Date | null>((latest, r) => (r.checkedAt && (!latest || r.checkedAt > latest) ? r.checkedAt : latest), null);
  const byId = new Map(results.map((r) => [r.id, r]));

  return {
    visibility: settings.visibility,
    hostingOverride: settings.hostingOverride,
    hosting: hosting
      ? {
          provider: providerLabel(hosting),
          region: locationLabel(provider, hosting),
          source: hosting.source,
          certification: provider
            ? { ...provider.certification, ...judgeProviderCert(hosting) }
            : null,
        }
      : null,
    checks: score.lines.map((l) => {
      const r = byId.get(l.check.id);
      return { id: l.check.id, weight: l.check.weight, earned: l.earned, title: l.check.title, state: l.state, evidence: r?.evidence ?? "Not checked yet.", checkedAt: r?.checkedAt?.toISOString() ?? null };
    }),
    score: {
      score: score.score,
      max: score.max,
      unverified: score.unverified,
      band: score.band,
      bandLabel: BANDS.find((b) => b.band === score.band)?.label ?? null,
      bands: BANDS.map((b) => ({ band: b.band, label: b.label, at: Math.ceil(score.max * b.share) })),
    },
    counts: countStates(results),
    steps: nextSteps(results).map((s) => ({ id: s.check.id, gain: s.gain, fix: s.fix, effort: s.check.effort, href: s.check.href, action: s.check.action, state: s.state, evidence: s.evidence })),
    history: {
      days: dailyLast(runs).map((r) => ({ day: r.ranAt.toISOString(), score: r.score, max: r.max })),
      changes: historyChanges(runs, titleOf).map((c) => ({ at: c.at.toISOString(), text: c.text })),
    },
    lastRunAt: lastRun?.toISOString() ?? null,
  };
}
