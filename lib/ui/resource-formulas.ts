// Plain-language sizing formulas and what they give on this host, for the Resources settings and app tabs.

import { DEPLOYS_FORMULA, REDIS_FORMULA, TIER_MEMORY_FORMULA, type HostSize, type ResourceDefaultKey } from "@/lib/resources/defaults";
import { LEARN_HEADROOM, LEARN_MIN_DAYS, formatMb, type LearnedStatus } from "@/lib/resources/learned";

export { formatMb };

export type FormulaRow = { key: ResourceDefaultKey; label: string; formula: string };

const { critical, standard, disposable } = TIER_MEMORY_FORMULA;

/** One row per sized default, in the order the summary reads. */
export const FORMULA_ROWS: readonly FormulaRow[] = [
  { key: "memoryCritical", label: "Critical", formula: `RAM ÷ ${critical.divisor}, between ${formatMb(critical.minMb)} (${formatMb(critical.largeHostMinMb)} from ${critical.largeHostGiB} GB of RAM) and ${formatMb(critical.maxMb)}` },
  { key: "memoryStandard", label: "Standard", formula: `RAM ÷ ${standard.divisor}, between ${formatMb(standard.minMb)} and ${formatMb(standard.maxMb)}` },
  { key: "memoryDisposable", label: "Disposable", formula: `Half of standard, at least ${formatMb(disposable.minMb)}` },
  {
    key: "deployConcurrency",
    label: "Deploys at once",
    formula: `One per ${DEPLOYS_FORMULA.coresPer} cores or per ${DEPLOYS_FORMULA.gibPer} GB of RAM, whichever is fewer, from ${DEPLOYS_FORMULA.min} to ${DEPLOYS_FORMULA.max}`,
  },
  { key: "redisMem", label: "Redis", formula: `RAM ÷ ${REDIS_FORMULA.divisor}, between ${formatMb(REDIS_FORMULA.minMb)} and ${formatMb(REDIS_FORMULA.maxMb)}` },
];

export const FORMULA_NOTES = [
  "RAM means installed memory: what the kernel reports plus about 4%, to the nearest GB. Memory values round to the nearest 64 MB.",
  "Standard apps get every core but one, disposable apps half and critical apps no CPU cap.",
  "Hosts with 25–31 GB get lower memory defaults than the old size bands did, and 7 GB hosts get one deploy at once instead of two. Learned defaults correct apps with history.",
  `After ${LEARN_MIN_DAYS} days, an app with no limit of its own gets its daily 99th-percentile memory plus ${Math.round((LEARN_HEADROOM - 1) * 100)}%, kept between half and twice its tier's default. It applies on the next deploy.`,
];

function ruleText(key: ResourceDefaultKey, rule: number | null | undefined): string | null {
  if (rule == null) return null;
  return key === "deployConcurrency" ? `${rule} ${rule === 1 ? "deploy" : "deploys"} at once` : formatMb(rule);
}

/** Each formula with what it gives on this host. Rules come from describeDefaults. */
export function formulaTable(rules: { key: ResourceDefaultKey; rule: number | null }[]): (FormulaRow & { here: string | null })[] {
  const byKey = new Map(rules.map((r) => [r.key, r.rule]));
  return FORMULA_ROWS.map((row) => ({ ...row, here: ruleText(row.key, byKey.get(row.key)) }));
}

/** "On this server (15.6 GB, 8 cores): critical 1.9 GB, standard 960 MB, …". Null when the host is unknown. */
export function hostSummary(host: HostSize | null, rules: { key: ResourceDefaultKey; rule: number | null }[]): string | null {
  if (!host) return null;
  const parts = formulaTable(rules)
    .filter((r) => r.here)
    .map((r) => (r.key === "deployConcurrency" ? r.here! : `${r.key.startsWith("memory") ? r.label.toLowerCase() : r.label} ${r.here}`));
  const gb = (host.memoryBytes / 1024 ** 3).toFixed(1);
  return `On this server (${gb} GB, ${host.cpus} ${host.cpus === 1 ? "core" : "cores"}): ${parts.join(", ")}.`;
}

/** The learned-default line on an app's Resources tab. */
export function learnedSummary(status: LearnedStatus, opts: { explicit: boolean; runningMb: number | null }): string {
  const { learned } = status;
  if (opts.explicit) {
    return learned
      ? `The limit set here wins over the learned default of ${formatMb(learned.mb)}.`
      : "The limit set here wins; nothing is learned while it's set.";
  }
  if (!learned) {
    return `Learning from use: ${status.days} of ${status.needDays} days recorded. The tier default applies until then.`;
  }
  const pending = opts.runningMb !== null && opts.runningMb !== learned.mb ? " Applies on the next deploy." : "";
  return `Learned default ${formatMb(learned.mb)}. ${learned.reason}.${pending}`;
}
