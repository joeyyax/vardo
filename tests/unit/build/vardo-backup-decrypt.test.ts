import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// The `vardo` wrapper install.sh writes to /usr/local/bin.
const installSh = readFileSync(join(__dirname, "../../../install.sh"), "utf8");
const wrapperBody = installSh.split("<<'WRAPPER'\n")[1].split("\nWRAPPER\n")[0];

let dir: string;

function runVardo(args: string[]) {
  const vardoDir = join(dir, "vardo");
  mkdirSync(join(vardoDir, "scripts"), { recursive: true });
  writeFileSync(join(vardoDir, "scripts/backup-decrypt.ts"), "");
  writeFileSync(join(vardoDir, ".env"), `ENCRYPTION_MASTER_KEY=${"a".repeat(64)}\n`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\ntouch "${dir}/docker-ran"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const wrapper = join(dir, "vardo-wrapper");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nVARDO_DIR="${vardoDir}"\n${wrapperBody}\n`);
  return spawnSync("bash", [wrapper, ...args], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
}

describe("vardo backup decrypt", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vardo-decrypt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a missing archive instead of mounting it", () => {
    const result = runVardo(["backup", "decrypt", "missing.tar.gz", "out.tar.gz"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No such file: missing.tar.gz");
    expect(existsSync(join(dir, "docker-ran"))).toBe(false);
  });

  it("runs the decrypt container for an archive that exists", () => {
    writeFileSync(join(dir, "in.tar.gz"), "x");
    const result = runVardo(["backup", "decrypt", "in.tar.gz", "out.tar.gz"]);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "docker-ran"))).toBe(true);
  });
});
