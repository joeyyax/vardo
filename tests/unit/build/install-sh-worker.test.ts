import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { workerMemMb } from "@/lib/resources/defaults";

// install.sh and the vardo wrapper: worker sizing, the legacy swap's worker and the worker commands.

let dir: string;
let lib: string;
let bin: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
case "$*" in
  *"exec -T frontend curl"*) [ "\${FAKE_FRONTEND:-ok}" = ok ] || exit 1 ;;
  *"exec -T worker curl"*) [ "\${FAKE_WORKER:-ok}" = ok ] || exit 1 ;;
  *"service=worker"*) echo "\${FAKE_WORKER_ID-wrk123}" ;;
  "inspect --format"*) echo "/vardo-production-blue-worker-1  running (healthy)  started x  restarts 0" ;;
  "exec wrk123 curl"*) echo '{"ok":true,"status":"ok"}' ;;
esac
exit 0
`;

function sh(script: string, env: Record<string, string> = {}, ramMb = 8192) {
  const vardo = mkdtempSync(join(dir, "vardo-"));
  const log = join(vardo, "docker.log");
  writeFileSync(log, "");
  writeFileSync(join(vardo, ".env"), env.ENV_FILE ?? "VARDO_ROLE=production\n");
  const slotParent = env.LAYOUT !== "legacy" ? "apps/vardo/production" : "apps/vardo/env";
  mkdirSync(join(vardo, slotParent, "blue/scripts"), { recursive: true });
  copyFileSync(join(__dirname, "../../../scripts/vardo-cli.sh"), join(vardo, slotParent, "blue/scripts/vardo-cli.sh"));
  symlinkSync("blue", join(vardo, slotParent, "current"));
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\nPLATFORM=macos\nget_ram_mb() { echo ${ramMb}; }\nsleep() { :; }\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VARDO_REF: "", VARDO_DIR: vardo, VARDO_BIN: join(vardo, "vardo-wrapper"), DOCKER_LOG: log, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, docker: readFileSync(log, "utf8"), env: readFileSync(join(vardo, ".env"), "utf8") };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-worker-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ensure_worker_mem", { timeout: 30_000 }, () => {
  it.each([1900, 2048, 3072, 3900, 4096, 6000, 7800, 8192, 16384, 65536])("matches lib/resources/defaults.ts at %i MB", (mb) => {
    const r = sh('ensure_worker_mem "$VARDO_DIR/.env" > /dev/null', {}, mb);
    expect(r.env).toContain(`VARDO_WORKER_MEM=${workerMemMb(mb)}m`);
  });

  it("sizes a quarter of RAM between 768m and 1536m", () => {
    expect(workerMemMb(2048)).toBe(768);
    expect(workerMemMb(4096)).toBe(1024);
    expect(workerMemMb(16384)).toBe(1536);
  });

  it("leaves a value the owner set", () => {
    const r = sh('ensure_worker_mem "$VARDO_DIR/.env" > /dev/null', { ENV_FILE: "VARDO_WORKER_MEM=2g\n" });
    expect(r.env).toBe("VARDO_WORKER_MEM=2g\n");
  });
});

describe("the legacy swap's worker", { timeout: 30_000 }, () => {
  it("stops the worker before the frontend", () => {
    const r = sh('stop_legacy_console "$VARDO_DIR/old.yml"');
    const lines = r.docker.trim().split("\n");
    expect(lines).toEqual([
      expect.stringContaining("stop worker"),
      expect.stringContaining("rm -f worker"),
      expect.stringContaining("stop frontend"),
      expect.stringContaining("rm -f frontend"),
    ]);
  });

  it("passes once the frontend and then the worker answer", () => {
    const r = sh('wait_legacy_console "$VARDO_DIR/new.yml" 30 && echo "HEALTHY $LEGACY_HEALTHY_AT"');
    expect(r.out).toMatch(/HEALTHY [1-9]\d+/);
    expect(r.out).toContain("New worker is healthy");
  });

  it("fails naming the worker when only the frontend comes up", () => {
    const r = sh('wait_legacy_console "$VARDO_DIR/new.yml" 9 || echo "FAILED $LEGACY_UNHEALTHY"', { FAKE_WORKER: "down" });
    expect(r.out).toContain("FAILED worker");
  });

  it("fails naming the frontend, without asking the worker, when the frontend never answers", () => {
    const r = sh('wait_legacy_console "$VARDO_DIR/new.yml" 9 || echo "FAILED $LEGACY_UNHEALTHY"', { FAKE_FRONTEND: "down" });
    expect(r.out).toContain("FAILED frontend");
    expect(r.docker).not.toContain("exec -T worker");
  });
});

describe("vardo worker commands", { timeout: 30_000 }, () => {
  const wrapper = (args: string, env: Record<string, string> = {}) => sh(`install_shortcut > /dev/null\nbash "$VARDO_BIN" ${args}`, env);

  it("shows the serving slot's worker state and /healthz", () => {
    const r = wrapper("worker status");
    expect(r.docker).toMatch(/ps -a -q --filter label=com.docker.compose.service=worker --filter label=com.docker.compose.project=vardo-production-blue/);
    expect(r.out).toContain("vardo-production-blue-worker-1  running (healthy)");
    expect(r.out).toContain('"status":"ok"');
  });

  it("says so when there's no worker yet", () => {
    const r = wrapper("worker status || echo EXIT", { FAKE_WORKER_ID: "" });
    expect(r.out).toContain("No worker container");
  });

  it("follows the worker's logs on a self-deploy instance and through compose on a legacy one", () => {
    expect(wrapper("logs worker").docker).toContain("docker logs -f wrk123");
    expect(wrapper("logs worker", { LAYOUT: "legacy" }).docker).toMatch(/docker compose -f .*env\/current\/docker-compose.yml logs -f worker/);
  });

  it("restarts the worker with the rest of the stack", () => {
    expect(wrapper("restart").docker).toMatch(/docker restart .*wrk123/);
  });
});
