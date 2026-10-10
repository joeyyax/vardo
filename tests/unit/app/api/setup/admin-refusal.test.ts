import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// A credential without instance-admin power gets a 403 that says why from every setup and admin route, never a 500.

vi.mock("@/lib/setup", () => ({ needsSetup: async () => false }));
vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: async () => null }));
vi.mock("@/lib/auth/admin", async () => {
  const errors = await import("@/lib/auth/admin-error");
  const refuse = async () => {
    throw new errors.AdminAuthError(403, errors.ADMIN_FORBIDDEN_MESSAGE);
  };
  return {
    ...errors,
    requireAppAdmin: refuse,
    requireAdminAuth: refuse,
    isAppAdmin: async () => false,
    canImportContainers: async () => false,
  };
});
vi.mock("@/lib/db", () => {
  const stub: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : stub),
    apply: () => stub,
  });
  return { db: stub };
});

const { ADMIN_FORBIDDEN_MESSAGE } = await import("@/lib/auth/admin-error");

const ROOT = path.resolve(__dirname, "../../../../..");
const DIRS = ["app/api/setup", "app/api/v1/admin"];

/** Routes that answer without an admin, with the reason. */
const EXEMPT: Record<string, string> = {
  "app/api/setup/token/route.ts": "trades the setup token for a cookie",
  "app/api/setup/status/route.ts": "returns whether setup is done",
  "app/api/setup/restore/route.ts": "restore status is public while the restore runs",
  "app/api/setup/restore/check/route.ts": "only answers during setup",
  "app/api/setup/restore/backups/route.ts": "only answers during setup",
  "app/api/setup/restore/start/route.ts": "only answers during setup",
  "app/api/v1/admin/stats/stream/route.ts": "an SSE stream that answers a plain 403",
};

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === "route.ts" ? [full] : [];
  });
}

const routes = DIRS.flatMap((d) => routeFiles(path.join(ROOT, d)))
  .map((f) => path.relative(ROOT, f))
  .filter((r) => !(r in EXEMPT))
  .sort();
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const cases = (
  await Promise.all(
    routes.map(async (rel) => {
      const mod = (await import(/* @vite-ignore */ path.join(ROOT, rel))) as Record<string, unknown>;
      return METHODS.filter((m) => typeof mod[m] === "function").map((m) => ({ route: `${m} ${rel}`, method: m, handler: mod[m] as Handler }));
    }),
  )
).flat();

describe("admin routes refuse a credential without admin power", () => {
  it("finds the routes", () => {
    expect(cases.length).toBeGreaterThan(40);
  });

  it.each(cases)("$route", async ({ method, handler }) => {
    const req = new NextRequest("http://localhost/api/x", {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer vardo_x" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    const res = await handler(req, { params: Promise.resolve({ backupId: "b", service: "s", name: "n", routeId: "r" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error ?? body.message).toBe(ADMIN_FORBIDDEN_MESSAGE);
  });
});
