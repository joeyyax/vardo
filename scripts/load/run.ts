import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { getJson, runLoad, authHeaders, type Config, type LoadResult, type Probe } from "./client";
import { holdStreams, type SseResult } from "./sse";
import { runDeployScenario, type DeployResult } from "./write";
import { startSampler, type ServerPeaks } from "./sampler";
import { defaultRate } from "./pacing";
import { renderComparison, type Report, type ResultRow } from "./compare";
import {
  deployRow, loadRow, renderDeploy, renderRequests, renderServer, renderSse, serverRow, sseRow,
} from "./report";

const USAGE = `pnpm test:load [options]
  pnpm test:load --compare old.json new.json

Environment
  VARDO_URL            Target, e.g. http://localhost:3000 (required)
  VARDO_TOKEN          API token (required unless VARDO_TOKENS is set)
  VARDO_TOKENS         Comma-separated API tokens, rotated per request; each gets its own rate budget
  VARDO_LOAD_ORG       Organization id for org-scoped scenarios; required with --write
  VARDO_LOAD_APP       App id for app detail, history and streams (default: first app in the org)
  VARDO_SESSION_COOKIE Session cookie ("name=value") for the admin overview; API tokens can't reach it

Options
  --concurrency 1,5,20   Concurrency levels per endpoint (default 1,5,20)
  --duration 10          Seconds per level (default 10)
  --streams 20           SSE streams per kind (default 20, server cap is 60 per token)
  --stream-seconds 20    Seconds to hold each stream group (default 20)
  --only a,b             Run only these: endpoints, sse, health, admin
  --rate 108             Requests per minute per token per route (default 108, 90% of the 120 read limit)
  --no-pace              Send as fast as the workers go (429s back off but the run measures the limiter)
  --write                Deploy scratch apps, then delete them (needs VARDO_LOAD_ORG)
  --apps 4               Scratch apps to deploy with --write (default 4)
  --image traefik/whoami Image for scratch apps
  --ssh user@host        Sample docker stats, Redis memory and Postgres connections
  --out file.json        Write the JSON report here (default load-<timestamp>.json)
  --compare a.json b.json  Print deltas between two reports and exit`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function loadReport(path: string): Promise<Report> {
  const report = JSON.parse(await readFile(path, "utf8")) as Report;
  if (report.version !== 1 || !Array.isArray(report.results)) die(`${path} is not a load report`);
  return report;
}

function positiveInt(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive integer`);
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      concurrency: { type: "string", default: "1,5,20" },
      duration: { type: "string", default: "10" },
      streams: { type: "string", default: "20" },
      "stream-seconds": { type: "string", default: "20" },
      only: { type: "string" },
      rate: { type: "string" },
      "no-pace": { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      apps: { type: "string", default: "4" },
      image: { type: "string", default: "traefik/whoami" },
      ssh: { type: "string" },
      out: { type: "string" },
      compare: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.compare) {
    if (positionals.length !== 2) die("--compare takes two files: --compare old.json new.json");
    console.log(renderComparison(await loadReport(positionals[0]), await loadReport(positionals[1])));
    return;
  }

  const url = process.env.VARDO_URL?.replace(/\/+$/, "");
  const tokens = (process.env.VARDO_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const token = process.env.VARDO_TOKEN || tokens[0];
  if (!url || !token) die(`VARDO_URL and VARDO_TOKEN (or VARDO_TOKENS) are required.\n\n${USAGE}`);
  if (!tokens.length) tokens.push(token);

  const org = process.env.VARDO_LOAD_ORG || null;
  if (values.write && !org) die("--write needs VARDO_LOAD_ORG set to the organization for the scratch apps.");

  const levels = values.concurrency!.split(",").map((v) => positiveInt("concurrency", v.trim()));
  const duration = positiveInt("duration", values.duration!);
  const streams = positiveInt("streams", values.streams!);
  const streamSeconds = positiveInt("stream-seconds", values["stream-seconds"]!);
  const appCount = positiveInt("apps", values.apps!);
  if (values.rate && values["no-pace"]) die("--rate and --no-pace can't be combined");
  const explicitRate = values.rate ? positiveInt("rate", values.rate) : null;
  const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
  const want = (name: string) => !only || only.has(name);

  const cfg: Config = {
    url,
    token,
    tokens,
    org,
    app: process.env.VARDO_LOAD_APP || null,
    cookie: process.env.VARDO_SESSION_COOKIE || null,
  };

  const notes: string[] = [];
  const results: ResultRow[] = [];
  const say = (m: string) => console.error(`[load] ${m}`);

  say(`target ${url}${org ? `, org ${org}` : ""}${values.write ? ", WRITE enabled" : ", read-only"}`);

  // Fail fast on a bad URL or token.
  const hc = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!hc) die(`Can't reach ${url}/api/health`);
  if (org) {
    const probe = await fetch(`${url}/api/v1/organizations/${org}/projects`, { headers: authHeaders(cfg) });
    if (probe.status === 401) die("VARDO_TOKEN was rejected (401). Is the api-tokens feature enabled?");
    if (!probe.ok) die(`Org ${org} isn't reachable with this token (${probe.status}).`);
  }

  if (org && !cfg.app && (want("endpoints") || want("sse"))) {
    const list = await getJson<{ apps: { id: string }[] }>(cfg, `/api/v1/organizations/${org}/apps?limit=1`);
    cfg.app = list.apps[0]?.id ?? null;
    if (!cfg.app) notes.push("No apps in the org; app detail, history and stream scenarios were skipped.");
  }

  const sampler = values.ssh ? startSampler(values.ssh) : null;
  const startedAt = new Date().toISOString();
  const requestRows: { name: string; r: LoadResult }[] = [];
  const sseRows: SseResult[] = [];
  let deploy: DeployResult | null = null;
  let peaks: ServerPeaks | null = null;

  const probes: (Probe & { group: string })[] = [];
  // Unauthenticated and cookie routes aren't on the token tier, so they pace only with an explicit --rate.
  const rateFor = (p: Probe) => (values["no-pace"] ? null : explicitRate ?? (p.tokens ? defaultRate() : null));
  if (want("health")) {
    probes.push({ id: "health", label: "GET /api/health", path: "/api/health", group: "health" });
  }
  if (want("endpoints") && org) {
    const base = `/api/v1/organizations/${org}`;
    probes.push(
      { id: "apps-list", label: "apps list", path: `${base}/apps?limit=50`, group: "endpoints", tokens },
      { id: "projects-list", label: "projects list", path: `${base}/projects`, group: "endpoints", tokens },
    );
    if (cfg.app) {
      probes.push(
        { id: "app-detail", label: "app detail", path: `${base}/apps/${cfg.app}`, group: "endpoints", tokens },
        { id: "metrics-history", label: "metrics history 1h", path: `${base}/apps/${cfg.app}/stats/history`, group: "endpoints", tokens },
      );
    }
  } else if (want("endpoints")) {
    notes.push("VARDO_LOAD_ORG not set; org-scoped endpoint and stream scenarios were skipped.");
  }
  if (want("admin")) {
    if (cfg.cookie) {
      probes.push({
        id: "admin-overview",
        label: "admin overview",
        path: "/api/v1/admin/overview",
        headers: { cookie: cfg.cookie },
        group: "admin",
      });
    } else {
      notes.push("VARDO_SESSION_COOKIE not set; admin overview skipped (API tokens can't reach admin routes).");
    }
  }

  try {
    for (const p of probes) {
      for (const c of levels) {
        const rate = rateFor(p);
        say(`${p.label} c=${c} for ${duration}s${rate ? `, ${rate}/min per token` : ", unpaced"}`);
        const r = await runLoad(url, p, c, duration, rate);
        requestRows.push({ name: p.label, r });
        results.push(loadRow(p.id, p.label, r));
      }
    }

    if (want("sse") && org && cfg.app) {
      for (const kind of ["metrics", "logs"] as const) {
        say(`sse ${kind}: ${streams} streams for ${streamSeconds}s`);
        const r = await holdStreams(cfg, kind, streams, streamSeconds);
        sseRows.push(r);
        results.push(sseRow(r));
      }
    }

    if (values.write) {
      say(`write: deploying ${appCount} scratch apps (${values.image})`);
      deploy = await runDeployScenario(cfg, appCount, values.image!, say);
      results.push(deployRow(deploy));
    }
  } finally {
    const stopped = sampler ? await sampler.stop() : null;
    if (stopped) {
      if (stopped.error) notes.push(`ssh sampling produced no samples: ${stopped.error}`);
      else results.push(serverRow(stopped.peaks));
      peaks = stopped.peaks;
    }
  }

  for (const { name, r } of requestRows) {
    if (r.rateLimited) {
      notes.push(`${name} c=${r.concurrency}: rate-limited, latencies not meaningful (${r.limited}/${r.requests} were 429). Lower --rate or add tokens to VARDO_TOKENS.`);
    }
  }
  if (sseRows.some((r) => r.limited > 0)) {
    notes.push("Some streams hit the per-token stream cap (60); lower --streams or use another token.");
  }
  if (sseRows.some((r) => r.kind === "metrics" && r.connected > 0 && r.lag.count === 0)) {
    notes.push("Metrics streams delivered no points (metrics disabled or no running containers for the app).");
  }
  if (sseRows.length) notes.push("SSE lag is client receive time minus server timestamp; clock skew counts on a remote target.");
  for (const e of deploy?.cleanupErrors ?? []) notes.push(`CLEANUP FAILED, remove by hand: ${e}`);
  for (const row of deploy?.rows.filter((r) => !r.success) ?? []) notes.push(`deploy failed: ${row.name}: ${row.error ?? "unknown"}`);

  console.log();
  if (requestRows.some((x) => x.r.rateLimited)) notes.push("* marks scenarios where more than 5% of requests were 429.");
  if (requestRows.length) console.log(`Requests (${duration}s per level)\n${renderRequests(requestRows)}\n`);
  if (sseRows.length) console.log(`SSE (${streamSeconds}s hold, times in ms)\n${renderSse(sseRows)}\n`);
  if (deploy) console.log(`Deploys\n${renderDeploy(deploy)}\n`);
  if (peaks) console.log(`Server peaks (${values.ssh})\n${renderServer(peaks)}\n`);
  for (const n of notes) console.log(`note: ${n}`);

  const report: Report = {
    version: 1,
    startedAt,
    target: url,
    options: {
      concurrency: levels, duration, tokens: tokens.length,
      rate: values["no-pace"] ? null : explicitRate ?? defaultRate(), streams, streamSeconds, write: values.write,
      apps: values.write ? appCount : null, ssh: Boolean(values.ssh), node: process.version,
    },
    results,
    notes,
  };
  const out = values.out ?? `load-${startedAt.replace(/[:.]/g, "-")}.json`;
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nreport: ${out}`);

  if (deploy?.cleanupErrors.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
