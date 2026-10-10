import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";
import { REACH_ROUTE_FILE, reachRouteConfig, writeReachRoute } from "@/lib/docker/reach-route";
import { parseCompose } from "@/lib/docker/compose";
import { slotTraefikNames } from "@/lib/docker/traefik-slot-names";

type Router = { rule: string; service: string; entryPoints: string[]; priority: number; tls?: unknown; middlewares?: string[] };
const routers = () => (reachRouteConfig() as { http: { routers: Record<string, Router> } }).http.routers;

describe("reachRouteConfig", () => {
  it("routes the reach prefix on every host and both entrypoints to the console", () => {
    const { "vardo-reach": https, "vardo-reach-http": http } = routers();
    for (const r of [https, http]) {
      expect(r.rule).toBe("PathPrefix(`/.well-known/vardo/`)");
      expect(r.service).toBe("vardo@docker");
      expect(r.priority).toBeGreaterThan(100);
      expect(r.middlewares).toBeUndefined();
    }
    expect(https.entryPoints).toEqual(["websecure"]);
    expect(https.tls).toEqual({});
    expect(http.entryPoints).toEqual(["web"]);
  });

  it("leaves the ACME challenge path alone", () => {
    for (const r of Object.values(routers())) {
      expect(r.rule).not.toContain("acme-challenge");
      expect(r.rule).not.toMatch(/PathPrefix\(`\/\.well-known\/?`\)/);
    }
  });

  it("points at a service both slots of the console declare", () => {
    const compose = parseCompose(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf-8"));
    const shared = new Set(Object.entries(compose.services).filter(([, s]) => (s as Record<string, unknown>)["x-vardo-shared"]).map(([n]) => n));
    for (const slot of ["blue", "green"]) {
      const labels = slotTraefikNames(compose, slot, { shared }).services.frontend.labels ?? {};
      expect(labels[`traefik.http.routers.vardo-${slot}.rule`]).toBeDefined();
      expect(labels["traefik.http.routers.vardo.rule"]).toBeUndefined();
      expect(labels["traefik.http.services.vardo.loadbalancer.server.port"]).toBe("3000");
    }
  });
});

describe("writeReachRoute", () => {
  it("writes the file Traefik's provider reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reach-route-"));
    try {
      expect(await writeReachRoute(dir)).toBe("written");
      expect(YAML.parse(await readFile(join(dir, REACH_ROUTE_FILE), "utf-8"))).toEqual(reachRouteConfig());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
