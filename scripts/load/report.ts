import type { Metrics, ResultRow } from "./compare";
import type { LoadResult } from "./client";
import type { SseResult } from "./sse";
import type { DeployResult } from "./write";
import type { ServerPeaks } from "./sampler";
import type { Summary } from "./stats";

const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

function pctl(prefix: string, s: Summary): Metrics {
  return { [`${prefix}p50`]: r1(s.p50), [`${prefix}p95`]: r1(s.p95), [`${prefix}p99`]: r1(s.p99) };
}

export function loadRow(id: string, label: string, r: LoadResult): ResultRow {
  return {
    id: `${id}@c${r.concurrency}`,
    label: `${label} c=${r.concurrency}`,
    metrics: {
      requests: r.requests,
      ok: r.ok,
      limited: r.limited,
      errors: r.errors,
      errorRate: Math.round(r.errorRate * 10000) / 100,
      rps: r1(r.rps),
      ...pctl("", r.latency),
      max: r1(r.latency.max),
    },
  };
}

export function sseRow(r: SseResult): ResultRow {
  return {
    id: `sse-${r.kind}@n${r.streams}`,
    label: `sse ${r.kind} n=${r.streams}`,
    metrics: {
      connected: r.connected,
      limited: r.limited,
      failed: r.failed,
      events: r.events,
      ...pctl("connect.", r.connect),
      "firstEvent.p50": r1(r.firstEvent.p50),
      "firstEvent.p95": r1(r.firstEvent.p95),
      ...pctl("lag.", r.lag),
      "gap.p50": r1(r.gap.p50),
      "gap.p95": r1(r.gap.p95),
    },
  };
}

export function deployRow(r: DeployResult): ResultRow {
  const metrics: Metrics = {
    succeeded: r.succeeded,
    failed: r.failed,
    wallMs: r1(r.wallMs),
    ...pctl("queueWait.", r.queueWait),
    ...pctl("total.", r.total),
    ...pctl("execution.", r.execution),
  };
  for (const [stage, s] of Object.entries(r.stages)) {
    metrics[`stage.${stage}.p50`] = r1(s.p50);
    metrics[`stage.${stage}.p95`] = r1(s.p95);
  }
  return { id: `deploy@k${r.apps}`, label: `deploy k=${r.apps}`, metrics };
}

export function serverRow(p: ServerPeaks): ResultRow {
  const metrics: Metrics = {
    samples: p.samples,
    redisUsedMiB: r1(p.redisUsedMiB),
    redisPeakMiB: r1(p.redisPeakMiB),
    pgConnections: p.pgConnections,
  };
  for (const [name, c] of Object.entries(p.containers)) {
    metrics[`${name}.cpuPct`] = r1(c.cpuPct);
    metrics[`${name}.memMiB`] = r1(c.memMiB);
  }
  return { id: "server-peaks", label: "server peaks", metrics };
}

export function table(headers: string[], rows: (string | number | null)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map((c) => (c === null ? "-" : String(c))))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(cells[0]), widths.map((w) => "-".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

const ms = (n: number | null) => (n === null ? null : n.toFixed(1));

export function renderRequests(rows: { name: string; r: LoadResult }[]): string {
  return table(
    ["endpoint", "conc", "reqs", "ok", "429", "err", "err%", "rps", "p50ms", "p95ms", "p99ms"],
    rows.map(({ name, r }) => [
      name, r.concurrency, r.requests, r.ok, r.limited, r.errors,
      (r.errorRate * 100).toFixed(1), r.rps.toFixed(1),
      ms(r.latency.p50), ms(r.latency.p95), ms(r.latency.p99),
    ]),
  );
}

export function renderSse(rows: SseResult[]): string {
  return table(
    ["stream", "n", "conn", "429", "fail", "events", "connP50", "connP95", "firstP95", "lagP50", "lagP95", "lagP99"],
    rows.map((r) => [
      r.kind, r.streams, r.connected, r.limited, r.failed, r.events,
      ms(r.connect.p50), ms(r.connect.p95), ms(r.firstEvent.p95),
      ms(r.lag.p50), ms(r.lag.p95), ms(r.lag.p99),
    ]),
  );
}

export function renderDeploy(r: DeployResult): string {
  const head = `${r.succeeded}/${r.apps} succeeded, wall ${(r.wallMs / 1000).toFixed(1)}s`;
  const rows: (string | number | null)[][] = [
    ["queue wait", ms(r.queueWait.p50), ms(r.queueWait.p95), ms(r.queueWait.max)],
    ["total", ms(r.total.p50), ms(r.total.p95), ms(r.total.max)],
    ["execution", ms(r.execution.p50), ms(r.execution.p95), ms(r.execution.max)],
    ...Object.entries(r.stages).map(([s, v]) => [`stage ${s}`, ms(v.p50), ms(v.p95), ms(v.max)]),
  ];
  return `${head}\n${table(["phase", "p50ms", "p95ms", "maxms"], rows)}`;
}

export function renderServer(p: ServerPeaks): string {
  const rows = Object.entries(p.containers)
    .sort((a, b) => b[1].memMiB - a[1].memMiB)
    .map(([n, c]) => [n, c.cpuPct.toFixed(1), c.memMiB.toFixed(0)]);
  const extra = [
    `redis used ${p.redisUsedMiB?.toFixed(1) ?? "-"} MiB (peak ${p.redisPeakMiB?.toFixed(1) ?? "-"} MiB)`,
    `postgres connections ${p.pgConnections ?? "-"}`,
    `${p.samples} samples`,
  ].join(", ");
  return `${table(["container", "cpu% peak", "mem MiB peak"], rows)}\n${extra}`;
}
