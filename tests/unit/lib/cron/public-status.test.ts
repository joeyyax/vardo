// The public cron status page and JSON: opt-in, aggregates only, and "ok" that a monitor can trust.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const h = vi.hoisted(() => ({ replaced: null as string | null }));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.replaced ? { "x-replaced-path": h.replaced } : {}),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { GET } = await import("@/app/api/status/cron/[token]/route");
const { default: Page } = await import("@/app/(public)/status/cron/[token]/page");
const { clearPublicCronStatusCache, summarize, jobState } = await import("@/lib/cron/public-status");

const TOKEN = "tok_abcdefghijklmnopqrstu";
const SECRET_NAME = "zebra-payroll-sync-7731";
const SECRET_URL = "https://hooks.secret-client.example/run?key=hunter2";
const SECRET_APP = "acme-billing-portal";

const ago = (ms: number) => new Date(Date.now() - ms);

function job(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    organizationId: "org-1",
    name: SECRET_NAME,
    type: "url",
    command: SECRET_URL,
    headers: "Authorization: Bearer hunter2",
    lastLog: `GET ${SECRET_URL} 200`,
    schedule: "*/5 * * * *",
    timeZone: null,
    enabled: true,
    lastRunAt: ago(60_000),
    lastStatus: "success",
    createdAt: ago(86_400_000),
    app: null,
    ...over,
  };
}

function seed({ enabled = true as boolean | null, jobs = [job()], tickAgoMs = 10_000 as number | null } = {}) {
  dbMock.query.cronStatusPages.findFirst.mockResolvedValue(
    enabled === null ? undefined : { organizationId: "org-1", enabled },
  );
  dbMock.query.cronJobs.findMany.mockResolvedValue(jobs);
  dbMock.query.jobHeartbeats.findFirst.mockResolvedValue(
    tickAgoMs === null ? undefined : { lastTickAt: ago(tickAgoMs), intervalMs: 60_000 },
  );
}

async function getJson() {
  const res = await GET(jsonRequest("GET", `/api/status/cron/${TOKEN}`), routeCtx({ token: TOKEN }));
  return { res, text: await res.text() };
}

async function renderPage() {
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ token: TOKEN }) })) as ReactElement);
}

beforeEach(() => {
  dbMock.reset();
  clearPublicCronStatusCache();
  h.replaced = null;
});

describe("privacy", () => {
  const leaky = [
    job(),
    job({ id: "job-2", type: "command", command: "php artisan secret:thing", app: { status: "active", name: SECRET_APP } }),
    job({ id: "job-3", lastStatus: "failed" }),
  ];

  it("keeps job names, URLs, commands, apps and logs out of the JSON", async () => {
    seed({ jobs: leaky });
    const { res, text } = await getJson();
    expect(res.status).toBe(200);
    for (const secret of [SECRET_NAME, "secret-client", "hunter2", "artisan", SECRET_APP, "org-1", "job-1"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps them out of the page", async () => {
    seed({ jobs: leaky });
    const html = await renderPage();
    expect(html).toContain("1 failing");
    for (const secret of [SECRET_NAME, "secret-client", "hunter2", "artisan", SECRET_APP, "org-1", "job-1", "*/5"]) {
      expect(html).not.toContain(secret);
    }
  });

  it("reads only the columns it shows", async () => {
    seed();
    await getJson();
    const { columns } = dbMock.query.cronJobs.findMany.mock.calls[0][0] as { columns: Record<string, boolean> };
    expect(Object.keys(columns).sort()).toEqual(["createdAt", "lastRunAt", "lastStatus", "schedule", "timeZone", "type"]);
  });
});

describe("opt-in", () => {
  it("404s the JSON and the page when the org turned it off", async () => {
    seed({ enabled: false });
    expect((await getJson()).res.status).toBe(404);
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s when the org never turned it on", async () => {
    seed({ enabled: null });
    expect((await getJson()).res.status).toBe(404);
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s a malformed token without a lookup", async () => {
    seed();
    const res = await GET(jsonRequest("GET", "/api/status/cron/x"), routeCtx({ token: "x" }));
    expect(res.status).toBe(404);
    expect(dbMock.query.cronStatusPages.findFirst).not.toHaveBeenCalled();
  });
});

describe("ok", () => {
  it("is true with healthy jobs and a live scheduler, sent uncached", async () => {
    seed({ jobs: [job(), job({ lastRunAt: null, createdAt: ago(30_000) })] });
    const { res, text } = await getJson();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(text).toContain('"ok":true');
    expect(JSON.parse(text)).toMatchObject({ ok: true, jobs: 2, healthy: 1, failing: 0, never_run: 1, scheduler_age_s: 10 });
  });

  it("flips on a failed job, still with a 200", async () => {
    seed({ jobs: [job(), job({ lastStatus: "failed" })] });
    const { res, text } = await getJson();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ ok: false, failing: 1 });
  });

  it("flips on a stale scheduler", async () => {
    seed({ tickAgoMs: 10 * 60_000 });
    expect(JSON.parse((await getJson()).text)).toMatchObject({ ok: false, scheduler_age_s: 600 });
  });

  it("flips when the scheduler never ticked", async () => {
    seed({ tickAgoMs: null });
    expect(JSON.parse((await getJson()).text)).toMatchObject({ ok: false, scheduler_age_s: null });
  });

  it("flips on a job overdue by more than twice its interval", async () => {
    seed({ jobs: [job({ lastRunAt: ago(30 * 60_000) })] });
    expect(JSON.parse((await getJson()).text)).toMatchObject({ ok: false, overdue: 1 });
  });

  it("leaves out jobs the scheduler skips", async () => {
    seed({ jobs: [job(), job({ type: "command", app: { status: "stopped" }, lastStatus: "failed" })] });
    expect(JSON.parse((await getJson()).text)).toMatchObject({ ok: true, jobs: 1 });
  });
});

describe("jobState", () => {
  const at = new Date("2026-10-09T09:01:00Z"); // A Friday.

  it("gives a weekday job the weekend before it reads overdue", () => {
    const monday = new Date("2026-10-12T09:01:00Z");
    const row = { schedule: "0 9 * * 1-5", timeZone: "UTC", lastRunAt: new Date("2026-10-09T09:00:00Z"), lastStatus: "success", createdAt: at };
    expect(jobState(row, monday).state).toBe("healthy");
  });

  it("counts a never-run job overdue once its window passes", () => {
    const row = { schedule: "*/5 * * * *", timeZone: null, lastRunAt: null, lastStatus: null, createdAt: new Date(at.getTime() - 3_600_000) };
    expect(jobState(row, at).state).toBe("overdue");
  });

  it("summarizes zero jobs as ok while the scheduler ticks", () => {
    expect(summarize([], { lastTickAt: at, intervalMs: 60_000 }, at)).toMatchObject({ ok: true, jobs: 0 });
  });
});

describe("page", () => {
  it("links the JSON at the custom host's path when Traefik rewrote the request", async () => {
    seed();
    h.replaced = "/";
    expect(await renderPage()).toContain('href="/status.json"');
  });

  it("links the console path otherwise", async () => {
    seed();
    expect(await renderPage()).toContain(`href="/api/status/cron/${TOKEN}"`);
  });

  it("serves later hits from the cache", async () => {
    seed();
    await getJson();
    await getJson();
    await renderPage();
    expect(dbMock.query.cronJobs.findMany).toHaveBeenCalledTimes(1);
  });
});
