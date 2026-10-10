import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { parseUpdateMarker } from "@/lib/lifecycle/classify";

// install.sh writes the update marker lib/lifecycle/monitor.ts reads.

let dir: string;
let lib: string;

function sh(vardoDir: string, script: string) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\nVARDO_DIR="${vardoDir}"\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, VARDO_REF: "" },
  });
  return r;
}

const marker = (vardoDir: string) => parseUpdateMarker(readFileSync(join(vardoDir, "lifecycle", "update.json"), "utf8"));

const START = `
UPDATE_MARKER_ID="20261009170000-42"
UPDATE_STARTED_AT=$(( $(date +%s) - 120 ))
UPDATE_FROM_VERSION="e36c2e3"
UPDATE_BRANCH="main"
UPDATE_FROM_SLOT="blue"
UPDATE_TO_SLOT="green"
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-marker-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("install.sh update marker", () => {
  it("writes started, then updated with the swap times", () => {
    const vardo = mkdtempSync(join(dir, "ok-"));
    const r = sh(
      vardo,
      `${START}
write_update_marker started
cat "$VARDO_DIR/lifecycle/update.json" > "$VARDO_DIR/started.json"
UPDATE_TO_VERSION="4f1a9b2"
write_update_marker updated "\\"finishedAt\\":$(date +%s)" "\\"swapStartedAt\\":$(( $(date +%s) - 18 ))" "\\"healthyAt\\":$(date +%s)"`,
    );
    expect(r.stderr).toBe("");
    expect(parseUpdateMarker(readFileSync(join(vardo, "started.json"), "utf8"))).toMatchObject({
      id: "20261009170000-42",
      state: "started",
      fromVersion: "e36c2e3",
      branch: "main",
      fromSlot: "blue",
      toSlot: "green",
    });
    const done = marker(vardo)!;
    expect(done).toMatchObject({ state: "updated", toVersion: "4f1a9b2" });
    expect(Math.round((done.healthyAt! - done.swapStartedAt!) / 1000)).toBe(18);
  });

  it("marks a failed run with its step, error and a clean log tail", () => {
    const vardo = mkdtempSync(join(dir, "fail-"));
    const log = join(vardo, "install.log");
    writeFileSync(log, `  \u001b[32m✓\u001b[0m Backup done\n\n  \u001b[1m  [5/8] Building green slot\u001b[0m\n#9 ERROR: "quoted" \\ path\n`);
    const r = sh(
      vardo,
      `${START}
INSTALL_LOG="${log}"
trap on_update_exit EXIT
write_update_marker started
step "Building green slot" > /dev/null
fail "docker compose build exited 1" > /dev/null`,
    );
    expect(r.status).toBe(1);
    expect(marker(vardo)).toMatchObject({
      state: "failed",
      step: "Building green slot",
      error: "docker compose build exited 1",
      rolledBack: false,
    });
    expect(marker(vardo)!.logTail!.slice(0, 3)).toEqual(["  ✓ Backup done", "    [5/8] Building green slot", '#9 ERROR: "quoted" \\ path']);
  });

  it("leaves a finished update alone on a later error", () => {
    const vardo = mkdtempSync(join(dir, "late-"));
    sh(
      vardo,
      `${START}
trap on_update_exit EXIT
write_update_marker started
UPDATE_TO_VERSION="4f1a9b2"
write_update_marker updated "\\"finishedAt\\":$(date +%s)"
false`,
    );
    expect(marker(vardo)).toMatchObject({ state: "updated" });
  });
});
