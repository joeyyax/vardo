import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { parseUpdateMarker } from "@/lib/lifecycle/classify";

// vardo update hands off to the target version's install.sh, and migrates .env with it.

let dir: string;
let lib: string;
let active: string;
let incoming: string;

const NEW_SCRIPT = `#!/usr/bin/env bash
echo "args:$*"
echo "env:$VARDO_UPDATE_REEXEC $VARDO_UPDATE_MARKER_ID $VARDO_UPDATE_STARTED_AT $VARDO_UPDATE_FROM_VERSION $VARDO_UPDATE_TO_SLOT"
`;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Runs a snippet with install.sh's functions loaded. `self` is the running script's path, $0. */
function sh(script: string, env: Record<string, string> = {}, self = "bash") {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\n${script}`, self], {
    encoding: "utf8",
    env: { ...process.env, VARDO_REF: "", TMPDIR: dir, VARDO_DIR: join(dir, "vardo"), ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const MARKER = `
UPDATE_MARKER_ID="20261009170000-42"
UPDATE_STARTED_AT=1791590000
UPDATE_FROM_VERSION="bc2083d"
UPDATE_BRANCH="main"
UPDATE_FROM_SLOT="blue"
UPDATE_TO_SLOT="green"
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-handoff-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));

  // The active slot, with origin/main fetched one commit ahead.
  active = join(dir, "active");
  mkdirSync(active);
  git(active, "init", "-q", "-b", "main");
  writeFileSync(join(active, "install.sh"), "#!/usr/bin/env bash\necho old\n");
  git(active, "add", ".");
  git(active, "commit", "-qm", "old");
  writeFileSync(join(active, "install.sh"), NEW_SCRIPT);
  git(active, "commit", "-qam", "new");
  git(active, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(active, "reset", "-q", "--hard", "HEAD~1");
  incoming = join(dir, "incoming.sh");
  writeFileSync(incoming, NEW_SCRIPT);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("update handoff", () => {
  it("runs the new version's install.sh with the marker and the original flags", () => {
    const r = sh(`${MARKER}\nORIG_ARGS=(update --verbose)\ncd "${active}"\nhandoff_update main\necho stayed`);
    expect(r.status).toBe(0);
    expect(r.out).toContain("args:update --yes --force update --verbose");
    expect(r.out).toContain("env:1 20261009170000-42 1791590000 bc2083d green");
    expect(r.out).not.toContain("stayed");
  });

  it("stays when the new install.sh is the one running", () => {
    const r = sh(`${MARKER}\ncd "${active}"\nhandoff_update main\necho stayed`, {}, incoming);
    expect(r.out.trim().split("\n").at(-1)).toBe("stayed");
  });

  it("hands off only once", () => {
    const r = sh(`${MARKER}\ncd "${active}"\nhandoff_update main\necho stayed`, { VARDO_UPDATE_REEXEC: "1" });
    expect(r.out.trim().split("\n").at(-1)).toBe("stayed");
  });

  it("stays when the branch has no install.sh", () => {
    const r = sh(`${MARKER}\ncd "${active}"\nhandoff_update nope\necho stayed`);
    expect(r.out).toContain("Updating with this one");
    expect(r.out.trim().split("\n").at(-1)).toBe("stayed");
  });

  it("removes the handed-off copy of install.sh", () => {
    const copy = join(dir, "vardo-install.copy");
    writeFileSync(copy, readFileSync(join(__dirname, "../../../install.sh")));
    const r = spawnSync("bash", [copy, "--help"], {
      encoding: "utf8",
      env: { ...process.env, VARDO_UPDATE_REEXEC: "1", VARDO_UPDATE_SCRIPT: copy, VARDO_DIR: join(dir, "vardo") },
    });
    expect(r.stdout).toContain("Usage: install.sh");
    expect(existsSync(copy)).toBe(false);
  });

  it("marks the handed-off update failed when the new script exits early", () => {
    const vardo = mkdtempSync(join(dir, "vardo-"));
    const r = sh(`resume_update_marker\nfail "Docker is not installed." > /dev/null`, {
      VARDO_DIR: vardo,
      VARDO_UPDATE_REEXEC: "1",
      VARDO_UPDATE_MARKER_ID: "20261009170000-42",
      VARDO_UPDATE_STARTED_AT: "1791590000",
      VARDO_UPDATE_FROM_VERSION: "bc2083d",
      VARDO_UPDATE_BRANCH: "main",
      VARDO_UPDATE_FROM_SLOT: "blue",
      VARDO_UPDATE_TO_SLOT: "green",
    });
    expect(r.status).toBe(1);
    const marker = parseUpdateMarker(readFileSync(join(vardo, "lifecycle", "update.json"), "utf8"));
    expect(marker).toMatchObject({
      id: "20261009170000-42",
      state: "failed",
      fromVersion: "bc2083d",
      toSlot: "green",
      error: "Docker is not installed.",
    });
  });
});

describe("REDIS_PASSWORD migration", () => {
  function migrate(env: string, role = "") {
    const file = join(mkdtempSync(join(dir, "env-")), ".env");
    writeFileSync(file, env);
    const r = sh(`VARDO_ROLE="${role}"\nensure_redis_password "${file}"`);
    expect(r.status).toBe(0);
    return readFileSync(file, "utf8");
  }

  it("generates one on installs without it", () => {
    expect(migrate("DB_PASSWORD=x\n")).toMatch(/^DB_PASSWORD=x\nREDIS_PASSWORD=[0-9a-f]{64}\n$/);
  });

  it("fills an empty one", () => {
    expect(migrate("REDIS_PASSWORD=\n")).toMatch(/^REDIS_PASSWORD=[0-9a-f]{64}\n$/);
  });

  it("keeps an existing one", () => {
    expect(migrate("REDIS_PASSWORD=kept\n")).toBe("REDIS_PASSWORD=kept\n");
  });

  it("leaves development installs alone", () => {
    expect(migrate("VARDO_ROLE=development\n", "development")).toBe("VARDO_ROLE=development\n");
  });
});
