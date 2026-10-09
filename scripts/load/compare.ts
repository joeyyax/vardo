export type Metrics = Record<string, number | null>;

export type ResultRow = {
  id: string;
  label: string;
  metrics: Metrics;
};

export type Report = {
  version: 1;
  startedAt: string;
  target: string;
  options: Record<string, unknown>;
  results: ResultRow[];
  notes: string[];
};

const HIGHER_IS_BETTER = /(^|\.)(rps|ok|connected|events|succeeded|streams)$/;

export function higherIsBetter(metric: string): boolean {
  return HIGHER_IS_BETTER.test(metric);
}

export type Delta = {
  id: string;
  label: string;
  metric: string;
  before: number | null;
  after: number | null;
  abs: number | null;
  pct: number | null;
  verdict: "better" | "worse" | "same" | "n/a";
};

/** Percent change below this reads as noise. */
export const NOISE_PCT = 5;

export function delta(metric: string, before: number | null, after: number | null) {
  if (before === null || after === null) {
    return { abs: null, pct: null, verdict: "n/a" as const };
  }
  const abs = after - before;
  const pct = before === 0 ? (after === 0 ? 0 : null) : (abs / Math.abs(before)) * 100;
  const significant = pct === null ? abs !== 0 : Math.abs(pct) >= NOISE_PCT;
  if (!significant) return { abs, pct, verdict: "same" as const };
  const improved = higherIsBetter(metric) ? abs > 0 : abs < 0;
  return { abs, pct, verdict: improved ? ("better" as const) : ("worse" as const) };
}

/** Deltas for every metric in rows both reports share, plus rows that exist on one side only. */
export function compareReports(before: Report, after: Report) {
  const afterById = new Map(after.results.map((r) => [r.id, r]));
  const beforeIds = new Set(before.results.map((r) => r.id));
  const deltas: Delta[] = [];

  for (const b of before.results) {
    const a = afterById.get(b.id);
    if (!a) continue;
    const keys = new Set([...Object.keys(b.metrics), ...Object.keys(a.metrics)]);
    for (const metric of keys) {
      const bv = b.metrics[metric] ?? null;
      const av = a.metrics[metric] ?? null;
      deltas.push({ id: b.id, label: b.label, metric, before: bv, after: av, ...delta(metric, bv, av) });
    }
  }

  return {
    deltas,
    onlyBefore: before.results.filter((r) => !afterById.has(r.id)).map((r) => r.id),
    onlyAfter: after.results.filter((r) => !beforeIds.has(r.id)).map((r) => r.id),
  };
}

function fmt(n: number | null, digits = 1): string {
  if (n === null) return "-";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function signed(n: number | null, suffix = ""): string {
  if (n === null) return "-";
  const s = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${n > 0 ? "+" : ""}${s}${suffix}`;
}

export function renderComparison(before: Report, after: Report): string {
  const { deltas, onlyBefore, onlyAfter } = compareReports(before, after);
  const rows = [["scenario", "metric", "before", "after", "delta", "change", ""]];
  let lastId = "";
  for (const d of deltas) {
    if (d.verdict === "n/a" && d.before === null && d.after === null) continue;
    rows.push([
      d.id === lastId ? "" : d.label,
      d.metric,
      fmt(d.before),
      fmt(d.after),
      signed(d.abs),
      signed(d.pct, "%"),
      d.verdict === "same" || d.verdict === "n/a" ? "" : d.verdict,
    ]);
    lastId = d.id;
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) =>
    r.map((c, i) => (i >= 2 && i <= 5 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd(),
  );
  lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));

  const better = deltas.filter((d) => d.verdict === "better").length;
  const worse = deltas.filter((d) => d.verdict === "worse").length;
  const out = [`before: ${before.target} @ ${before.startedAt}`, `after:  ${after.target} @ ${after.startedAt}`, "", ...lines, ""];
  out.push(`${better} better, ${worse} worse (changes under ${NOISE_PCT}% count as noise)`);
  if (onlyBefore.length) out.push(`only in before: ${onlyBefore.join(", ")}`);
  if (onlyAfter.length) out.push(`only in after: ${onlyAfter.join(", ")}`);
  return out.join("\n");
}
