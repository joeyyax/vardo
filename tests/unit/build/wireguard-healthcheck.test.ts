import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { parse } from "yaml";

// The frontend waits for this check, and the frontend writes wg0.conf.
const compose = parse(readFileSync(join(__dirname, "../../../docker-compose.yml"), "utf8"));
const command: string = compose.services.wireguard.healthcheck.test[1];

let dir: string;

function runCheck(wgUp: boolean): number {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "wg"), wgUp ? "#!/bin/sh\necho 'interface: wg0'\n" : "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "wg"), 0o755);
  const script = command.replaceAll("/config/", `${dir}/config/`);
  return spawnSync("sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` } }).status ?? -1;
}

describe("wireguard healthcheck", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-health-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on a fresh install with no wg0.conf", () => {
    expect(compose.services.frontend.depends_on.wireguard.condition).toBe("service_healthy");
    expect(runCheck(false)).toBe(0);
  });

  it("fails when wg0.conf exists and the interface is down", () => {
    mkdirSync(join(dir, "config/wg_confs"), { recursive: true });
    writeFileSync(join(dir, "config/wg_confs/wg0.conf"), "[Interface]\n");
    expect(runCheck(false)).not.toBe(0);
  });

  it("passes when wg0 is up", () => {
    mkdirSync(join(dir, "config/wg_confs"), { recursive: true });
    writeFileSync(join(dir, "config/wg_confs/wg0.conf"), "[Interface]\n");
    expect(runCheck(true)).toBe(0);
  });
});
