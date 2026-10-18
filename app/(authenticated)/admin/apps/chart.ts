// Line and area paths for sparks and drill-in charts. Nulls break the line.

export type Paths = { line: string; area: string };

/** Paths for `values` across `w` by `h`, scaled to `max` (the series' own peak with headroom when omitted). */
export function seriesPaths(values: (number | null)[], w: number, h: number, max?: number | null): Paths {
  const peak = max ?? Math.max(0, ...values.filter((v): v is number => v !== null)) * 1.15;
  const top = peak > 0 ? peak : 1;
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const y = (v: number) => h - 1 - (Math.min(v, top) / top) * (h - 2);
  let line = "";
  let area = "";
  let run: number[] = [];
  const close = () => {
    if (run.length === 0) return;
    const pts = run.map((i) => `${x(i).toFixed(1)} ${y(values[i]!).toFixed(1)}`);
    line += `M${pts.join("L")}`;
    area += `M${x(run[0]).toFixed(1)} ${h}L${pts.join("L")}L${x(run.at(-1)!).toFixed(1)} ${h}Z`;
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) close();
    else run.push(i);
  });
  close();
  return { line, area };
}

/** Pixel y for `v` on the same scale as seriesPaths. */
export function yFor(v: number, h: number, max: number): number {
  return h - 1 - (Math.min(v, max) / max) * (h - 2);
}
