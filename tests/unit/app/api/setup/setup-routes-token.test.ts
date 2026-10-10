import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// Every setup and restore route refuses without the setup token while no user exists (#888).

const state = vi.hoisted(() => ({ needsSetup: true, admin: true }));
vi.mock("@/lib/setup", () => ({ needsSetup: async () => state.needsSetup }));
vi.mock("@/lib/auth/admin", () => {
  const requireAppAdmin = async () => {
    if (!state.admin) throw new Error("Forbidden");
  };
  return { requireAppAdmin, requireAdminAuth: requireAppAdmin, isAppAdmin: async () => state.admin };
});
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
}));
// Past the gate the routes reach for the database; a deep stub keeps that from throwing.
vi.mock("@/lib/db", () => {
  const stub: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : stub),
    apply: () => stub,
  });
  return { db: stub };
});

const API = path.resolve(__dirname, "../../../../../app/api/setup");
const TOKEN = "0123456789abcdef0123456789abcdef";

/** Routes that must answer before the token exists, with the reason. */
const EXEMPT: Record<string, string> = {
  "token/route.ts": "trades the token for the cookie",
  "status/route.ts": "returns one boolean the root redirect already shows",
};

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === "route.ts" ? [full] : [];
  });
}

const routes = routeFiles(API).map((f) => path.relative(API, f)).sort();
const gated = routes.filter((r) => !(r in EXEMPT));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function handlersOf(rel: string): Promise<[string, Handler][]> {
  const mod = (await import(/* @vite-ignore */ path.join(API, rel))) as Record<string, unknown>;
  return METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as Handler]);
}

function request(method: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/setup/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

async function isRefusal(res: Response | undefined) {
  if (!res || res.status !== 401) return false;
  return ((await res.clone().json().catch(() => ({}))) as { code?: string }).code === "setup_token_required";
}

async function call(handler: Handler, headers?: Record<string, string>, method = "POST") {
  try {
    return await handler(request(method, headers), { params: Promise.resolve({ appId: "a" }) });
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  state.needsSetup = true;
  state.admin = true;
  vi.stubEnv("SETUP_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("setup routes", () => {
  it("finds the routes, so a bad path can't pass vacuously", () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(routes).toContain("restore/start/route.ts");
  });

  it("keeps the exemptions from outliving their routes", () => {
    for (const rel of Object.keys(EXEMPT)) expect(routes).toContain(rel);
  });

  it.each(gated)("%s refuses a request without the token", async (rel) => {
    const handlers = await handlersOf(rel);
    expect(handlers.length).toBeGreaterThan(0);
    for (const [method, h] of handlers) {
      expect(await isRefusal(await call(h, undefined, method)), `${rel} ${method}`).toBe(true);
    }
  });

  it.each(gated)("%s refuses the wrong token", async (rel) => {
    for (const [method, h] of await handlersOf(rel)) {
      expect(await isRefusal(await call(h, { "x-setup-token": "wrong" }, method)), `${rel} ${method}`).toBe(true);
      expect(await isRefusal(await call(h, { cookie: "vardo_setup_token=wrong" }, method)), `${rel} ${method}`).toBe(true);
    }
  });

  it.each(gated)("%s gets past the gate with the right token", async (rel) => {
    for (const [method, h] of await handlersOf(rel)) {
      expect(await isRefusal(await call(h, { "x-setup-token": TOKEN }, method)), `${rel} ${method}`).toBe(false);
      expect(await isRefusal(await call(h, { cookie: `vardo_setup_token=${TOKEN}` }, method)), `${rel} ${method}`).toBe(false);
    }
  });

  it.each(gated)("%s stops asking once setup has latched", async (rel) => {
    state.needsSetup = false;
    for (const [method, h] of await handlersOf(rel)) {
      expect(await isRefusal(await call(h, undefined, method)), `${rel} ${method}`).toBe(false);
    }
  });
});

describe("admin routes open during setup", () => {
  const ADMIN = path.resolve(__dirname, "../../../../../app/api/v1/admin");
  const OPEN_DURING_SETUP = ["config/import/route.ts", "mesh/join/route.ts"];

  it("covers every API route that skips auth while setup is open", () => {
    const API_ROOT = path.resolve(API, "..");
    const skipsAuth = routeFiles(API_ROOT)
      .filter((f) => !f.startsWith(API + path.sep) && !f.includes(`${path.sep}auth${path.sep}`))
      .filter((f) => fs.readFileSync(f, "utf8").includes("needsSetup"))
      .map((f) => path.relative(ADMIN, f))
      .sort();
    expect(skipsAuth).toEqual(OPEN_DURING_SETUP);
  });

  it.each(OPEN_DURING_SETUP)("%s refuses a request without the token", async (rel) => {
    const { POST } = (await import(/* @vite-ignore */ path.join(ADMIN, rel))) as { POST: Handler };
    expect(await isRefusal(await call(POST))).toBe(true);
    expect(await isRefusal(await call(POST, { "x-setup-token": "wrong" }))).toBe(true);
    expect(await isRefusal(await call(POST, { "x-setup-token": TOKEN }))).toBe(false);
  });
});

describe("setup config routes after setup", () => {
  const CONFIG = ["general", "auth", "email", "backup", "github"].map((r) => `${r}/route.ts`);

  async function forbidden(handler: Handler, method: string) {
    try {
      const res = await handler(request(method, { "x-setup-token": TOKEN }), { params: Promise.resolve({}) });
      return res.status === 401 || res.status === 403;
    } catch (err) {
      return err instanceof Error && ["Forbidden", "Unauthorized"].includes(err.message);
    }
  }

  it.each(CONFIG)("%s refuses a non-admin even with the token", async (rel) => {
    state.needsSetup = false;
    state.admin = false;
    for (const [method, h] of await handlersOf(rel)) {
      expect(await forbidden(h, method), `${rel} ${method}`).toBe(true);
    }
  });

  it.each(CONFIG)("%s lets an admin through", async (rel) => {
    state.needsSetup = false;
    for (const [method, h] of await handlersOf(rel)) {
      expect(await forbidden(h, method), `${rel} ${method}`).toBe(false);
    }
  });
});

describe("POST /api/setup/token", () => {
  async function post(token: unknown) {
    const { POST } = (await import("@/app/api/setup/token/route")) as { POST: Handler };
    return POST(
      new NextRequest("http://localhost/api/setup/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      { params: Promise.resolve({}) },
    );
  }

  it("refuses a wrong token and sets no cookie", async () => {
    const res = await post("wrong");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sets an httpOnly cookie for the right token", async () => {
    const res = await post(TOKEN);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vardo_setup_token=${TOKEN}`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("is closed once setup has latched", async () => {
    state.needsSetup = false;
    expect((await post(TOKEN)).status).toBe(403);
  });
});
