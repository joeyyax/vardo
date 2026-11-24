// The log client against a real VictoriaLogs: org isolation, the viewer's filters and the error counts.
// Skips without one: VICTORIALOGS_TEST_URL, e.g. `docker run -p 127.0.0.1:19428:9428 victoriametrics/victoria-logs:v1.52.0`.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const VL = process.env.VICTORIALOGS_TEST_URL?.replace(/\/+$/, "");

// Accounts unique to this run, so reruns against one server don't see each other.
const base = 100_000 + Math.floor(Math.random() * 1_000_000);
const ACCOUNTS: Record<string, number> = { "org-a": base, "org-b": base + 1 };

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (_col: unknown, value: string) => value,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizations: {
        findFirst: async ({ where }: { where: string }) => (where in ACCOUNTS ? { logAccountId: ACCOUNTS[where] } : undefined),
      },
    },
  },
}));

const { buildLogsQLQuery, queryFieldValues, queryHits, queryLogs, queryStats, tailLogs } = await import("@/lib/logging/victorialogs");
const { errorCountQuery, lineCountQuery } = await import("@/lib/logging/error-shape");

const run = randomUUID().slice(0, 8);

/** One line as the log shipper writes it. */
function line(msg: string, fields: Record<string, string>, ago = 10_000) {
  return {
    _time: new Date(Date.now() - ago).toISOString(),
    _msg: msg,
    host: "test",
    container: `${fields.project}-blue-${fields.service}-1`,
    compose_service: fields.service,
    "vardo.project": fields.project,
    "vardo.project.id": fields.projectId,
    "vardo.environment": fields.environment ?? "production",
    run,
  };
}

async function push(org: string, rows: object[]) {
  const res = await fetch(`${VL}/insert/jsonline?_stream_fields=container,vardo.project&_time_field=_time&_msg_field=_msg`, {
    method: "POST",
    headers: { "Content-Type": "application/stream+json", AccountID: String(ACCOUNTS[org]) },
    body: rows.map((r) => JSON.stringify(r)).join("\n"),
  });
  expect(res.ok).toBe(true);
}

/** Lines become searchable about a second after ingest. */
async function settle(org: string, expected: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await queryLogs({ query: `run:=${JSON.stringify(run)}`, organizationId: org, start: new Date(Date.now() - 3_600_000) });
    if (rows.length >= expected) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${org}: lines never became searchable`);
}

const A = { project: "shop", projectId: "app-a", service: "web" };
const B = { project: "shop", projectId: "app-b", service: "web" };
const hour = () => new Date(Date.now() - 3_600_000);

describe.skipIf(!VL)("VictoriaLogs client against a real server", () => {
  const original = process.env.VICTORIALOGS_URL;

  beforeAll(async () => {
    process.env.VICTORIALOGS_URL = VL;
    // Two organizations with an app of the same name: only the account tells them apart.
    await push("org-a", [
      line("GET / 200", A),
      line("TypeError: cannot read a", A),
      line('{"level":"info","msg":"json without a msg key is kept whole"}', A),
      line("price is $5.00 (net) [EUR]", A),
      line("worker started", { ...A, service: "worker" }),
      line("staging only", { ...A, environment: "staging" }),
    ]);
    await push("org-b", [line("org B secret", B), line("FATAL org B failure", B)]);
    await settle("org-a", 6);
    await settle("org-b", 2);
  });

  afterAll(() => {
    if (original === undefined) delete process.env.VICTORIALOGS_URL;
    else process.env.VICTORIALOGS_URL = original;
  });

  it("never returns another organization's lines, even for an app of the same name", async () => {
    const a = await queryLogs({ query: buildLogsQLQuery({ project: "shop" }), organizationId: "org-a", start: hour() });
    const b = await queryLogs({ query: buildLogsQLQuery({ project: "shop" }), organizationId: "org-b", start: hour() });
    expect(a.map((e) => e.line)).not.toContain("org B secret");
    expect(a.every((e) => e.labels["vardo.project.id"] === "app-a")).toBe(true);
    expect(b.map((e) => e.line).sort()).toEqual(["FATAL org B failure", "org B secret"]);
  });

  it("keeps each organization's counts, values and hits to its own lines", async () => {
    const values = await queryFieldValues({ query: `run:=${JSON.stringify(run)}`, organizationId: "org-b", field: "vardo.project.id", start: hour() });
    expect(values.map((v) => v.value)).toEqual(["app-b"]);

    const hits = await queryHits({ query: `run:=${JSON.stringify(run)}`, organizationId: "org-b", start: hour(), step: "1h" });
    expect(hits.reduce((n, h) => n + h.total, 0)).toBe(2);

    const lines = await queryStats(`run:=${JSON.stringify(run)} | stats count() n`, "org-a");
    expect(lines[0].value).toBe(6);
  });

  it("tails only the organization's own new lines", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const tail = tailLogs({ query: `run:=${JSON.stringify(run)}`, organizationId: "org-a" }, (e) => seen.push(e.line), controller.signal);
    await new Promise((r) => setTimeout(r, 500));
    await push("org-b", [line("org B live", B, 0)]);
    await push("org-a", [line("org A live", A, 0)]);
    for (let i = 0; i < 60 && !seen.includes("org A live"); i++) await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await tail;
    expect(seen).toContain("org A live");
    expect(seen).not.toContain("org B live");
  }, 30_000);

  it("applies the viewer's environment and service filters", async () => {
    const lines = async (filter: Parameters<typeof buildLogsQLQuery>[0]) =>
      (await queryLogs({ query: `${buildLogsQLQuery(filter)} run:=${JSON.stringify(run)}`, organizationId: "org-a", start: hour() })).map((e) => e.line);

    expect(await lines({ project: "shop", environment: "staging" })).toEqual(["staging only"]);
    expect(await lines({ project: "shop", environment: "production", service: "worker" })).toEqual(["worker started"]);
    expect(await lines({ project: "other" })).toEqual([]);
  });

  it("searches case-insensitively and literally, metacharacters included", async () => {
    const search = async (term: string) =>
      (await queryLogs({ query: `${buildLogsQLQuery({ project: "shop", search: term })} run:=${JSON.stringify(run)}`, organizationId: "org-a", start: hour() })).map((e) => e.line);

    expect(await search("typeerror")).toEqual(["TypeError: cannot read a"]);
    expect(await search("$5.00 (net) [EUR]")).toEqual(["price is $5.00 (net) [EUR]"]);
    expect(await search("5.0.")).toEqual([]);
    expect(await search('"level":"info"')).toHaveLength(1);
  });

  it("returns the line as written, a JSON line without a msg key included", async () => {
    const rows = await queryLogs({ query: `${buildLogsQLQuery({ project: "shop", search: "json without" })}`, organizationId: "org-a", start: hour() });
    expect(rows[0].line).toBe('{"level":"info","msg":"json without a msg key is kept whole"}');
  });

  it("counts errors and lines per app and service for the error rate", async () => {
    const byApp = (rows: { labels: Record<string, string>; value: number }[]) =>
      Object.fromEntries(rows.map((r) => [`${r.labels["vardo.project.id"]}/${r.labels.compose_service}`, r.value]));

    const errorsA = byApp(await queryStats(errorCountQuery(3600), "org-a"));
    const errorsB = byApp(await queryStats(errorCountQuery(3600), "org-b"));
    expect(errorsA["app-a/web"]).toBeGreaterThanOrEqual(1);
    expect(errorsA["app-b/web"]).toBeUndefined();
    expect(errorsB["app-b/web"]).toBeGreaterThanOrEqual(1);

    const linesA = byApp(await queryStats(lineCountQuery(3600), "org-a"));
    expect(linesA["app-a/worker"]).toBeGreaterThanOrEqual(1);
  });
});
