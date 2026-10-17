// On real Docker: once isolateConsole runs, an app container can't reach the console and Traefik still can (#1136).
// Skips without a Docker daemon. Address checks run only where the daemon isolates bridges, as Linux Docker does and OrbStack doesn't.

import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import { dockerIsolationDeps, isolateConsole } from "@/lib/docker/console-network";

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
}

let hasDocker = true;
try {
  docker("info", "--format", "{{.ServerVersion}}");
} catch {
  hasDocker = false;
}

const IMAGE = "nginx:1.31.6-alpine";
const HOOK_TIMEOUT = 180_000;
const id = randomBytes(3).toString("hex");
const apps = `vardo-test-1136-apps-${id}`;
const consoleNet = `vardo-test-1136-console-${id}`;
const names = {
  console: `vardo-test-1136-console-${id}`,
  traefik: `vardo-test-1136-traefik-${id}`,
  app: `vardo-test-1136-app-${id}`,
  probe: `vardo-test-1136-probe-${id}`,
};

/** A network on its own /24, trying a few in case one is taken. */
function createNetwork(name: string, base: number): void {
  for (let i = 0; i < 20; i++) {
    try {
      docker("network", "create", "--subnet", `10.${base}.${(Number.parseInt(id, 16) + i * 13) % 250}.0/24`, name);
      return;
    } catch (err) {
      if (!/overlap|in use/i.test(String((err as { stderr?: string }).stderr ?? err))) throw err;
    }
  }
  throw new Error(`No free subnet for ${name}`);
}

/** Whether `from` gets an HTTP answer from `target`. */
function reaches(from: string, target: string): boolean {
  try {
    docker("exec", from, "wget", "-q", "-T", "3", "-O", "/dev/null", `http://${target}/`);
    return true;
  } catch {
    return false;
  }
}

function ipOn(container: string, network: string): string {
  return docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container);
}

describe.skipIf(!hasDocker)("console isolation on Docker", { timeout: 180_000 }, () => {
  let consoleId = "";
  let traefikId = "";
  let consoleIpOnApps = "";
  let bridgesIsolated = false;

  beforeAll(() => {
    try {
      docker("image", "inspect", IMAGE);
    } catch {
      docker("pull", IMAGE);
    }
    createNetwork(apps, 231);
    createNetwork(consoleNet, 232);
    // As the engine before #1136 started it: on the apps network only, labeled for the console network.
    consoleId = docker("run", "-d", "--name", names.console, "--network", apps, "--label", `traefik.docker.network=${consoleNet}`, IMAGE);
    traefikId = docker("run", "-d", "--name", names.traefik, "--network", apps, IMAGE);
    docker("run", "-d", "--name", names.app, "--network", apps, IMAGE);
    consoleIpOnApps = ipOn(names.console, apps);
    docker("run", "-d", "--name", names.probe, "--network", consoleNet, IMAGE);
    bridgesIsolated = !reaches(names.app, ipOn(names.probe, consoleNet));
  }, HOOK_TIMEOUT);

  afterAll(() => {
    for (const name of Object.values(names)) {
      try { docker("rm", "-f", name); } catch { /* gone */ }
    }
    for (const net of [apps, consoleNet]) {
      try { docker("network", "rm", net); } catch { /* gone */ }
    }
  }, HOOK_TIMEOUT);

  it("starts with the app able to reach the console", () => {
    expect(reaches(names.app, names.console)).toBe(true);
  });

  it("cuts the app off and keeps Traefik's path", async () => {
    const plan = await isolateConsole({
      ...dockerIsolationDeps,
      self: () => consoleId,
      traefik: async () => traefikId,
      networks: { console: consoleNet, apps },
    });
    expect(plan.steps).toEqual(["join-console", "attach-traefik", "leave-vardo-network"]);

    expect(docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", names.console)).not.toContain(`"${apps}"`);
    expect(reaches(names.app, names.console)).toBe(false);
    expect(reaches(names.app, consoleIpOnApps)).toBe(false);
    if (bridgesIsolated) expect(reaches(names.app, ipOn(names.console, consoleNet))).toBe(false);
    expect(reaches(names.traefik, names.console)).toBe(true);
    expect(reaches(names.traefik, names.app)).toBe(true);
  });

  it("does nothing on a second pass", async () => {
    const plan = await isolateConsole({
      ...dockerIsolationDeps,
      self: () => consoleId,
      traefik: async () => traefikId,
      networks: { console: consoleNet, apps },
    });
    expect(plan.steps).toEqual([]);
  });
});
