// The page's payload, built from settings and the latest results.

import { computeLevel, countStates, nextSteps, summarizeLevels } from "./level";
import { findProvider, judgeProviderCert, locationLabel } from "./hosting";
import { effectiveHosting, getTrustSettings, providerLabel, readResults } from "./store";
import { CHECKS, type CheckState, type Level } from "./types";

export type TrustView = {
  visibility: "off" | "private";
  hostingOverride: { provider: string; region: string } | null;
  hosting: {
    provider: string;
    region: string | null;
    source: "detected" | "manual";
    certification: { standard: string; number: string | null; url: string; state: CheckState; evidence: string } | null;
  } | null;
  checks: { id: string; level: Level; title: string; state: CheckState; evidence: string; checkedAt: string | null }[];
  levels: ReturnType<typeof summarizeLevels>;
  level: Level | null;
  counts: Record<CheckState, number>;
  steps: { id: string; level: Level; fix: string; effort: string; href: string; action: string; state: CheckState; evidence: string }[];
  lastRunAt: string | null;
};

export async function buildTrustView(): Promise<TrustView> {
  const [settings, results] = await Promise.all([getTrustSettings(), readResults()]);
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
    checks: CHECKS.map((c) => {
      const r = byId.get(c.id);
      return { id: c.id, level: c.level, title: c.title, state: r?.state ?? "unknown", evidence: r?.evidence ?? "Not checked yet.", checkedAt: r?.checkedAt?.toISOString() ?? null };
    }),
    levels: summarizeLevels(results),
    level: computeLevel(results),
    counts: countStates(results),
    steps: nextSteps(results).map((s) => ({ id: s.check.id, level: s.check.level, fix: s.fix, effort: s.check.effort, href: s.check.href, action: s.check.action, state: s.state, evidence: s.evidence })),
    lastRunAt: lastRun?.toISOString() ?? null,
  };
}
