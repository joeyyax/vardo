// Apps on vardo-network must not reach the console without Traefik (#1136): only Traefik shares a network with it.

import { execFileSync } from "child_process";
import { copyFile, mkdtemp, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { injectNetwork, vardoNetworkServices } from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose";
import { CONSOLE_NETWORK, NETWORK_NAME } from "@/lib/docker/constants";

type Service = { networks?: string[] | Record<string, unknown>; labels?: string[]; network_mode?: string };

const raw = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
const compose = parse(raw) as { services: Record<string, Service> };

const networksOf = (svc: Service) => (Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks ?? {}));
const label = (svc: Service, key: string) => svc.labels?.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

describe("console network", () => {
  it("keeps the console off vardo-network and every network an app joins", () => {
    const nets = networksOf(compose.services.frontend);
    expect(nets).not.toContain(NETWORK_NAME);
    expect(nets.some((n) => n.startsWith("vardo-p-"))).toBe(false);
    expect(nets).toContain("console");
  });

  it("shares the console network with Traefik and nothing else", () => {
    const members = Object.entries(compose.services).filter(([, svc]) => networksOf(svc).includes("console")).map(([name]) => name);
    expect(members.sort()).toEqual(["frontend", "traefik"]);
    expect(networksOf(compose.services.traefik)).toEqual(expect.arrayContaining([NETWORK_NAME, "console"]));
  });

  it("tells Traefik to reach the console on it", () => {
    expect(label(compose.services.frontend, "traefik.docker.network")).toBe(CONSOLE_NETWORK);
    expect(label(compose.services.frontend, "vardo.traefik")).toBe("manual");
  });

  it("isn't put back on vardo-network by a deploy", () => {
    const parsed = parseCompose(raw);
    expect(vardoNetworkServices(parsed).has("frontend")).toBe(false);
    const injected = injectNetwork(parsed, NETWORK_NAME, { attachTo: vardoNetworkServices(parsed) });
    expect(injected.services.frontend.networks).not.toContain(NETWORK_NAME);
  });

  it("still puts an app's routed service on vardo-network", () => {
    const app = parseCompose(`services:\n  web:\n    image: nginx\n    labels:\n      traefik.enable: "true"\n      traefik.docker.network: other\n`);
    expect(vardoNetworkServices(app).has("web")).toBe(true);
  });
});

let hasCompose = true;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  hasCompose = false;
}

describe.skipIf(!hasCompose)("console network as compose resolves it", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vardo-console-network-"));
    await copyFile(join(process.cwd(), "docker-compose.yml"), join(dir, "docker-compose.yml"));
    await writeFile(join(dir, ".env"), "");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("names the network the label points Traefik at", () => {
    const out = execFileSync(
      "docker",
      ["compose", "-f", join(dir, "docker-compose.yml"), "--profile", "production", "config", "--format", "json"],
      { cwd: dir, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DB_PASSWORD: "x" } as unknown as NodeJS.ProcessEnv },
    );
    const cfg = JSON.parse(out) as { networks: Record<string, { name: string }>; services: Record<string, { labels?: Record<string, string> }> };
    expect(cfg.networks.console.name).toBe(CONSOLE_NETWORK);
    expect(cfg.services.frontend.labels?.["traefik.docker.network"]).toBe(cfg.networks.console.name);
  });
});
