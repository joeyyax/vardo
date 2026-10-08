import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// With the mesh flag off, no mesh route answers: each returns 404 before it touches data.

const untouchable = vi.hoisted(() => ({
  db: new Proxy({}, { get: () => { throw new Error("db touched"); } }),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/db", () => ({ db: untouchable.db }));
vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => ({}) }));
vi.mock("@/lib/setup", () => ({ needsSetup: async () => false }));
vi.mock("@/lib/mesh/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer: async () => ({ id: "peer1", type: "persistent", organizationId: "org1" }),
}));

const API = path.resolve(__dirname, "../../../../app/api/v1");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === "route.ts" ? [full] : [];
  });
}

const routes = [...routeFiles(path.join(API, "mesh")), ...routeFiles(path.join(API, "admin/mesh"))];

const params = Promise.resolve({ code: "abc", peerId: "p1" });

describe("mesh routes and the mesh flag", () => {
  beforeEach(() => {
    vi.stubEnv("VARDO_FEATURE_MESH", "off");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds the routes, so a bad path cannot pass vacuously", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
  });

  it.each(routes.map((f) => [path.relative(API, f), f]))("%s answers 404 when the flag is off", async (_rel, file) => {
    const mod = await import(/* @vite-ignore */ file);
    const handlers = METHODS.filter((m) => typeof mod[m] === "function");
    expect(handlers.length).toBeGreaterThan(0);
    for (const method of handlers) {
      const req = new NextRequest("http://localhost/api/v1/mesh/x", {
        method,
        body: method === "GET" ? undefined : JSON.stringify({}),
        headers: { "content-type": "application/json", authorization: "Bearer t" },
      });
      const res = await mod[method](req, { params });
      expect(res.status, `${method} ${_rel}`).toBe(404);
      expect((await res.json()).error).toMatch(/isn't enabled/);
    }
  });

  it("lets a request past the gate when the flag is on", async () => {
    vi.stubEnv("VARDO_FEATURE_MESH", "on");
    const mod = await import("@/app/api/v1/admin/mesh/peers/route");
    const res = await mod.GET();
    expect(res.status).not.toBe(404);
  });
});
