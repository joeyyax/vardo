// Every route the homelab (10.0.0.19) serves today must render byte-identical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { injectTraefikLabels } from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose-parse";
import { interpolate } from "@/lib/docker/compose-hosts";
import type { ComposeFile } from "@/lib/docker/compose-types";

type Route = {
  app: string;
  idPrefix: string;
  domain: string;
  port: number | null;
  sslEnabled: boolean | null;
  certResolver: string | null;
  redirectTo: string | null;
  redirectCode: number | null;
  middlewares: string | null;
  backendProtocol: "http" | "https" | null;
  labels: Record<string, string>;
};

type Fixture = {
  env: Record<string, string>;
  console: Record<string, string>;
  routes: Route[];
};

const fx: Fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/sample-routes.json"), "utf-8"));

function render(route: Route): Record<string, string> {
  const projectName = `${route.app}-${route.idPrefix}`;
  const port = Number(route.labels[`traefik.http.services.${route.app}.loadbalancer.server.port`]);
  const compose: ComposeFile = { services: { app: { name: "app", image: "x" } } };
  const out = injectTraefikLabels(compose, {
    projectName,
    appName: route.app,
    domain: route.domain,
    containerPort: port,
    certResolver: route.certResolver || "le-dns",
    ssl: route.sslEnabled ?? true,
    redirectTo: route.redirectTo ?? undefined,
    redirectCode: route.redirectCode ?? 301,
    serviceName: "app",
    backendProtocol: route.backendProtocol ?? "http",
  });
  return Object.fromEntries(
    Object.entries(out.services.app.labels ?? {}).filter(([k]) => k !== "traefik.enable").sort(([a], [b]) => a.localeCompare(b)),
  );
}

function renderConsole(env: Record<string, string>): Record<string, string> {
  const compose = parseCompose(readFileSync(join(__dirname, "../../../../docker-compose.yml"), "utf-8"));
  const labels = compose.services.frontend.labels ?? {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(labels)) {
    if (!k.startsWith("traefik.")) continue;
    const v = interpolate(String(raw), {}, env);
    if ("error" in v) throw new Error(`${k}: ${v.error}`);
    out[k] = v.value;
  }
  return out;
}

describe("homelab routes", () => {
  it("covers the snapshot", () => {
    expect(fx.routes.length).toBeGreaterThan(30);
  });

  it.each(fx.routes.map((r) => [r.domain, r] as const))("%s renders as it runs", (_d, route) => {
    expect(render(route)).toEqual(route.labels);
  });

  it("renders the console's routers as they run", () => {
    expect(renderConsole(fx.env)).toEqual(fx.console);
  });
});
