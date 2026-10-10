import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComposeRoute } from "@/lib/domains/compose-routes";

type Write = { op: "delete" | "update" | "insert"; set?: Record<string, unknown>; values?: Record<string, unknown>[] };

const { state } = vi.hoisted(() => ({
  state: {
    selects: [] as unknown[][],
    writes: [] as Write[],
    containers: [] as { labels: Record<string, string> }[],
    instanceDomain: "console.example.com" as string | undefined,
  },
}));

vi.mock("@/lib/db", () => {
  const select = () => {
    const result = state.selects.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const k of ["from", "where", "limit", "innerJoin"]) chain[k] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return chain;
  };
  const exec = {
    select,
    delete: () => ({ where: async () => { state.writes.push({ op: "delete" }); } }),
    update: () => ({ set: (set: Record<string, unknown>) => ({ where: async () => { state.writes.push({ op: "update", set }); } }) }),
    insert: () => ({
      values: (values: Record<string, unknown>[]) => ({
        onConflictDoNothing: async () => { state.writes.push({ op: "insert", values }); },
      }),
    }),
  };
  return { db: { ...exec, transaction: async <T>(fn: (tx: typeof exec) => Promise<T>) => fn(exec) } };
});
vi.mock("@/lib/docker/client", () => ({ listContainers: async () => state.containers }));
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: async () => ({ domain: state.instanceDomain }) }));

import {
  consoleRoutes,
  planComposeDomains,
  reconcileComposeDomains,
  syncComposeDomains,
  syncConsoleDomains,
  type FamilyRow,
} from "@/lib/domains/compose-domains";

const route = (over: Partial<ComposeRoute> = {}): ComposeRoute => ({
  service: "web",
  router: "site",
  host: "app.example.com",
  pathPrefix: null,
  tls: true,
  certResolver: "le",
  port: 8080,
  ...over,
});

const row = (over: Partial<FamilyRow> = {}): FamilyRow => ({
  id: "c1",
  appId: "parent",
  domain: "app.example.com",
  pathPrefix: null,
  source: "compose",
  composeRouter: "site",
  serviceName: "web",
  port: 8080,
  sslEnabled: true,
  certResolver: "le",
  ...over,
});

const plan = (input: Partial<Parameters<typeof planComposeDomains>[0]>) =>
  planComposeDomains({
    parentAppId: "parent",
    childByService: new Map(),
    routes: [],
    rows: [],
    takenElsewhere: new Set(),
    ...input,
  });

beforeEach(() => {
  state.selects = [];
  state.writes = [];
  state.containers = [];
  state.instanceDomain = "console.example.com";
});

describe("planComposeDomains", () => {
  it("inserts a new route as a compose row", () => {
    const p = plan({ routes: [route()] });
    expect(p.insert).toEqual([
      { appId: "parent", domain: "app.example.com", pathPrefix: null, serviceName: "web", port: 8080, sslEnabled: true, certResolver: "le", composeRouter: "site" },
    ]);
    expect(p.remove).toEqual([]);
  });

  it("puts a child service's route on the child app", () => {
    const p = plan({ routes: [route({ service: "admin" })], childByService: new Map([["admin", "child"]]) });
    expect(p.insert[0].appId).toBe("child");
  });

  it("keeps an unchanged row and updates a changed one in place", () => {
    expect(plan({ routes: [route()], rows: [row()] })).toMatchObject({ insert: [], update: [], remove: [] });
    const p = plan({ routes: [route({ port: 9000 })], rows: [row()] });
    expect(p.update).toEqual([{ id: "c1", set: { port: 9000 } }]);
  });

  it("removes rows whose label is gone", () => {
    const p = plan({ routes: [route({ host: "new.example.com" })], rows: [row()] });
    expect(p.remove).toEqual(["c1"]);
    expect(p.insert.map((r) => r.domain)).toEqual(["new.example.com"]);
  });

  it("removes every compose row when the compose routes nothing", () => {
    expect(plan({ rows: [row(), row({ id: "c2", domain: "b.example.com" })] }).remove).toEqual(["c1", "c2"]);
  });

  it("lets a managed domain win and flags the redundant label", () => {
    const managed = row({ id: "m1", source: "vardo", composeRouter: null });
    const p = plan({ routes: [route()], rows: [managed] });
    expect(p.insert).toEqual([]);
    expect(p.flag).toEqual([{ id: "m1", composeRouter: "site" }]);
  });

  it("flags a label the deploy stripped but the file still declares", () => {
    const managed = row({ id: "m1", source: "vardo", composeRouter: null });
    expect(plan({ declared: [route({ router: "old" })], rows: [managed] }).flag).toEqual([{ id: "m1", composeRouter: "old" }]);
  });

  it("clears the flag once the label is gone", () => {
    const managed = row({ id: "m1", source: "vardo", composeRouter: "site" });
    expect(plan({ rows: [managed] }).flag).toEqual([{ id: "m1", composeRouter: null }]);
  });

  it("keys on host and path", () => {
    const managed = row({ id: "m1", source: "vardo", composeRouter: null });
    const p = plan({ routes: [route({ pathPrefix: "/api" })], rows: [managed] });
    expect(p.insert.map((r) => r.pathPrefix)).toEqual(["/api"]);
    expect(p.flag).toEqual([]);
  });

  it("skips a host another app holds, with a note", () => {
    const p = plan({ routes: [route()], takenElsewhere: new Set(["app.example.com|"]) });
    expect(p.insert).toEqual([]);
    expect(p.notes[0]).toContain("belongs to another app");
  });
});

describe("syncComposeDomains", () => {
  it("replaces the app's compose rows on deploy", async () => {
    state.selects = [
      [],
      [row({ id: "gone", domain: "old.example.com" }), row({ id: "m1", source: "vardo", domain: "shop.example.com", composeRouter: null })],
      [],
    ];
    await syncComposeDomains({ parentAppId: "parent", routes: [route(), route({ host: "shop.example.com", router: "shop" })] });
    expect(state.writes.map((w) => w.op)).toEqual(["delete", "update", "insert"]);
    expect(state.writes[1].set).toEqual({ composeRouter: "shop" });
    expect(state.writes[2].values).toEqual([expect.objectContaining({ domain: "app.example.com", source: "compose", isPrimary: false })]);
  });
});

describe("console hostname", () => {
  it("lists dotted console hosts on Vardo's app", () => {
    expect(consoleRoutes(["console.example.com", "localhost"], "le")).toEqual([
      { service: "frontend", router: "vardo", host: "console.example.com", pathPrefix: null, tls: true, certResolver: "le", port: 3000 },
    ]);
  });

  it("writes the instance domain as a compose row", async () => {
    state.selects = [[], [], []];
    await syncConsoleDomains("vardo-app");
    const insert = state.writes.find((w) => w.op === "insert");
    expect(insert?.values?.[0]).toMatchObject({ appId: "vardo-app", domain: "console.example.com", serviceName: "frontend" });
  });
});

describe("reconcileComposeDomains", () => {
  const labels = (over: Record<string, string> = {}) => ({
    "vardo.project.id": "app1",
    "vardo.environment": "production",
    "com.docker.compose.service": "web",
    "traefik.http.routers.app1-site-green.rule": "Host(`app.example.com`)",
    ...over,
  });

  it("lists routes from running containers for an app without compose rows", async () => {
    state.containers = [{ labels: labels() }];
    state.selects = [
      [{ id: "app1", name: "shop" }],
      [],
      [],
      [{ name: "production" }],
      [],
      [],
      [],
    ];
    expect(await reconcileComposeDomains()).toEqual({ synced: 1 });
    const insert = state.writes.find((w) => w.op === "insert");
    expect(insert?.values?.[0]).toMatchObject({ appId: "app1", domain: "app.example.com", composeRouter: "site" });
  });

  it("leaves apps a deploy already covered", async () => {
    state.containers = [{ labels: labels() }];
    state.selects = [[{ id: "app1", name: "shop" }], [], [{ id: "c1", source: "compose" }]];
    expect(await reconcileComposeDomains()).toEqual({ synced: 0 });
    expect(state.writes).toEqual([]);
  });

  it("ignores other environments' containers", async () => {
    state.containers = [{ labels: labels({ "vardo.environment": "staging" }) }];
    state.selects = [[{ id: "app1", name: "shop" }], [], [], [{ name: "production" }]];
    expect(await reconcileComposeDomains()).toEqual({ synced: 0 });
  });

  it("does nothing without Vardo containers", async () => {
    state.containers = [{ labels: { "com.docker.compose.service": "x" } }];
    expect(await reconcileComposeDomains()).toEqual({ synced: 0 });
  });
});
