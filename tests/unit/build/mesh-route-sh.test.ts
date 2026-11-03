import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// scripts/mesh-route.sh against stub `docker` and `ip` that keep state in files.

const SCRIPT = join(__dirname, "../../../scripts/mesh-route.sh");

let dir: string;

function stub(name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** WireGuard's networks as `docker inspect` prints them, or null when the container doesn't exist. */
function wireguard(networks: Record<string, string> | null) {
  writeFileSync(join(dir, "networks"), networks ? Object.entries(networks).map(([n, ip]) => `${n} ${ip}\n`).join("") : "");
  writeFileSync(join(dir, "exists"), networks ? "1" : "0");
}

function route(via: string | null) {
  writeFileSync(join(dir, "route"), via ? `10.99.0.0/24 via ${via} dev eth2 \n` : "");
}

const currentVia = () => readFileSync(join(dir, "route"), "utf8").match(/via (\S+)/)?.[1] ?? null;

function run() {
  return spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, VARDO_MESH_ROUTE_ONCE: "1" },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mesh-route-"));
  stub("docker", `[ "$(cat "${dir}/exists")" = 1 ] || { echo "No such object" >&2; exit 1; }\ncat "${dir}/networks"`);
  stub(
    "ip",
    `case "$1 $2" in
  "route show") cat "${dir}/route" ;;
  "route replace") echo "$3 via $5 dev eth2 " > "${dir}/route"; echo replaced >> "${dir}/calls" ;;
esac`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("mesh-route.sh", () => {
  it("moves the route to WireGuard's new mesh address", () => {
    wireguard({ "vardo-network": "192.168.16.70", vardo_internal: "172.18.0.6", vardo_mesh: "10.88.0.6" });
    route("10.88.0.2");

    const r = run();

    expect(r.status).toBe(0);
    expect(currentVia()).toBe("10.88.0.6");
    expect(r.stdout).toContain("10.99.0.0/24 via 10.88.0.6 (was 10.88.0.2)");
  });

  it("finds the mesh network under a plain compose project name", () => {
    wireguard({ "vardo-dev_internal": "172.20.0.2", "vardo-dev_mesh": "10.88.0.9" });
    route(null);

    run();

    expect(currentVia()).toBe("10.88.0.9");
  });

  it("leaves a correct route alone", () => {
    wireguard({ vardo_mesh: "10.88.0.2" });
    route("10.88.0.2");

    run();

    expect(existsSync(join(dir, "calls"))).toBe(false);
  });

  it("keeps the route when WireGuard isn't there", () => {
    wireguard(null);
    route("10.88.0.2");

    const r = run();

    expect(r.status).toBe(0);
    expect(currentVia()).toBe("10.88.0.2");
  });

  it("keeps the route when WireGuard has no mesh address", () => {
    wireguard({ vardo_internal: "172.18.0.6", vardo_mesh: "" });
    route("10.88.0.2");

    run();

    expect(currentVia()).toBe("10.88.0.2");
  });
});
