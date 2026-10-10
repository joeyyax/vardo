import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// vardo update on a self-deploy instance redeploys the vardo app through the console; it never runs the legacy swap.

let dir: string;
let lib: string;
let bin: string;

// Answers the calls install.sh makes, and logs every one.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
args="$*"
case "$args" in
  "exec vardo-postgres psql"*) echo "\${FAKE_STATUS:-success}" ;;
  "exec vardo-postgres pg_dump"*) [ "\${FAKE_PGDUMP:-ok}" = ok ] || exit 1; echo "-- dump" ;;
  "exec vardo-redis"*) echo 0 ;;
  "inspect vardo-frontend"*) [ -n "\${FAKE_LEGACY:-}" ] || exit 1 ;;
  "ps -q --filter name=^vardo-frontend\\$"*) [ -z "\${FAKE_LEGACY:-}" ] || echo legacy1 ;;
  "ps -q --filter label=com.docker.compose.project=vardo-production-"*) echo "\${FAKE_CONSOLE-abc123}" ;;
  "ps --filter label=com.docker.compose.service=frontend"*) echo "vardo-production-blue-frontend-1 vardo-production-blue" ;;
  "exec abc123 curl"*) [ "\${FAKE_HEALTHY:-1}" = 1 ] || exit 1 ;;
esac
exit 0
`;

/** A fresh VARDO_DIR. `layout` picks the console's layout. */
function instance(layout: "self-deploy" | "legacy"): string {
  const vardo = mkdtempSync(join(dir, `${layout}-`));
  writeFileSync(join(vardo, ".env"), "VARDO_ROLE=production\nCOMPOSE_PROFILES=production,buildkit\n");
  mkdirSync(join(vardo, "lifecycle"));
  mkdirSync(join(vardo, "apps/vardo/env/blue"), { recursive: true });
  writeFileSync(join(vardo, "apps/vardo/env/blue/install.sh"), "echo LEGACY-INSTALL-SH \"$@\"\n");
  symlinkSync("blue", join(vardo, "apps/vardo/env/current"));
  if (layout === "self-deploy") {
    mkdirSync(join(vardo, "apps/vardo/production/blue"), { recursive: true });
    writeFileSync(join(vardo, "apps/vardo/production/blue/install.sh"), "echo SLOT-INSTALL-SH \"$@\"\n");
    symlinkSync("blue", join(vardo, "apps/vardo/production/current"));
  }
  return vardo;
}

/** A console that takes requests: a fresh ready file, and an answer to the first request. */
const CONSOLE = (answer: string) => `
printf '{"at":%s}\\n' "$(date +%s)" > "$VARDO_DIR/lifecycle/deploy-requests.ready"
(
  for _ in $(seq 1 100); do
    if [ -f "$VARDO_DIR/lifecycle/deploy-request.json" ]; then
      id=$(json_member id "$VARDO_DIR/lifecycle/deploy-request.json")
      rm -f "$VARDO_DIR/lifecycle/deploy-request.json"
      printf '{"id":"%s",${answer}}\\n' "$id" > "$VARDO_DIR/lifecycle/deploy-request.result.json"
      exit 0
    fi
    sleep 0.1
  done
) &
`;

function sh(vardo: string, script: string, env: Record<string, string> = {}) {
  const log = join(vardo, "docker.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\nPLATFORM=macos\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VARDO_REF: "",
      VARDO_DIR: vardo,
      VARDO_BIN: join(vardo, "vardo-wrapper"),
      DOCKER_LOG: log,
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, docker: readFileSync(log, "utf8") };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-self-deploy-"));
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

describe("vardo update on a self-deploy instance", { timeout: 30_000 }, () => {
  it("redeploys through the console and leaves .env and compose alone", () => {
    const vardo = instance("self-deploy");
    const r = sh(vardo, `${CONSOLE('"state":"accepted","deploymentId":"dep_123"')}\nAUTO_YES=true\ndo_update`);
    expect(r.out).toContain("Deployment dep_123 queued");
    expect(r.out).toContain("Update complete!");
    expect(r.status).toBe(0);
    expect(r.docker).not.toMatch(/docker compose/);
    expect(readFileSync(join(vardo, ".env"), "utf8")).toBe("VARDO_ROLE=production\nCOMPOSE_PROFILES=production,buildkit\n");
    expect(readFileSync(join(vardo, "install.sh"), "utf8")).toContain("SLOT-INSTALL-SH");
  });

  it("writes only the install-time options given on the command line", () => {
    const vardo = instance("self-deploy");
    sh(vardo, `${CONSOLE('"state":"accepted","deploymentId":"dep_123"')}\nAUTO_YES=true\ndo_update`, {
      VARDO_TRUSTED_PROXIES: "192.0.2.10",
    });
    expect(readFileSync(join(vardo, ".env"), "utf8")).toBe(
      "VARDO_ROLE=production\nCOMPOSE_PROFILES=production,buildkit\nVARDO_TRUSTED_PROXIES=192.0.2.10\n",
    );
  });

  it("refreshes the vardo wrapper before deploying", () => {
    const vardo = instance("self-deploy");
    sh(vardo, `${CONSOLE('"state":"refused","error":"nope"')}\nAUTO_YES=true\ndo_update`);
    expect(existsSync(join(vardo, "vardo-wrapper"))).toBe(true);
  });

  it("reports a refusal", () => {
    const vardo = instance("self-deploy");
    const r = sh(vardo, `${CONSOLE('"state":"refused","error":"Vardo is restarting to finish an update"')}\nAUTO_YES=true\ndo_update`);
    expect(r.status).toBe(1);
    expect(r.out).toContain("The console refused the deploy: Vardo is restarting to finish an update");
  });

  it("reports a failed deploy with the step from update.json", () => {
    const vardo = instance("self-deploy");
    writeFileSync(
      join(vardo, "lifecycle/update.json"),
      '{"id":"dep_123","kind":"self-deploy","state":"failed","startedAt":1,"step":"healthcheck","error":"green slot did not become healthy"}\n',
    );
    const r = sh(vardo, `${CONSOLE('"state":"accepted","deploymentId":"dep_123"')}\nAUTO_YES=true\ndo_update`, { FAKE_STATUS: "failed" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Failed at healthcheck: green slot did not become healthy");
    expect(r.out).toContain("The previous console is still serving");
  });

  it("drops the marker an older install.sh wrote before handing off", () => {
    const vardo = instance("self-deploy");
    writeFileSync(join(vardo, "lifecycle/update.json"), '{"id":"20261009170000-42","state":"started","startedAt":1}\n');
    sh(vardo, `${CONSOLE('"state":"accepted","deploymentId":"dep_123"')}\ndo_update`, {
      VARDO_UPDATE_REEXEC: "1",
      VARDO_UPDATE_MARKER_ID: "20261009170000-42",
    });
    expect(existsSync(join(vardo, "lifecycle/update.json"))).toBe(false);
  });

  it("waits for no console that never said it listens", () => {
    const vardo = instance("self-deploy");
    expect(sh(vardo, "wait_for_request_listener 0").status).toBe(1);
    writeFileSync(join(vardo, "lifecycle/deploy-requests.ready"), `{"at":${Math.floor(Date.now() / 1000) - 600}}\n`);
    expect(sh(vardo, "wait_for_request_listener 0").status).toBe(1);
  });

  it("flags a second slot console still running", () => {
    const vardo = instance("self-deploy");
    const r = sh(vardo, `slot_consoles() { printf 'a vardo-production-blue\\nb vardo-production-green\\n'; }\nsleep() { :; }\nverify_self_deploy dep_123 || echo FLAGGED`);
    expect(r.out).toContain("More than one slot console is running");
    expect(r.out).toContain("FLAGGED");
  });
});

describe("vardo update on a legacy instance", () => {
  it("migrates with --yes", () => {
    const vardo = instance("legacy");
    const r = sh(vardo, `do_migrate_self_deploy() { echo MIGRATING; }\nAUTO_YES=true\ndo_update`);
    expect(r.out).toContain("MIGRATING");
  });

  it("runs the legacy update when asked to, without offering", () => {
    const vardo = instance("legacy");
    const r = sh(vardo, `do_migrate_self_deploy() { echo MIGRATING; }\nAUTO_YES=true\ndo_update`, { VARDO_UPDATE_LEGACY: "1" });
    expect(r.out).not.toContain("MIGRATING");
    expect(r.out).toContain("is not a git repository");
  });
});

describe("vardo migrate-self-deploy", () => {
  it("is a no-op on an instance that already deploys itself", () => {
    const vardo = instance("self-deploy");
    const r = sh(vardo, "AUTO_YES=true\ndo_migrate_self_deploy");
    expect(r.status).toBe(0);
    expect(r.out).toContain("Vardo already deploys itself (slot blue)");
    expect(r.docker).not.toMatch(/docker (stop|rm)/);
  });

  it("stops before anything changes when the backup fails", () => {
    const vardo = instance("legacy");
    const r = sh(vardo, "AUTO_YES=true\ndo_migrate_self_deploy", { FAKE_LEGACY: "1", FAKE_PGDUMP: "fail" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Database backup failed");
    expect(r.docker).not.toMatch(/docker (stop|rm)/);
    expect(existsSync(join(vardo, "lifecycle/deploy-request.json"))).toBe(false);
  });

  it("backs up, deploys through the console and only then retires vardo-frontend", { timeout: 30_000 }, () => {
    const vardo = instance("legacy");
    // The engine writes production/current as the deploy lands.
    const deploy = `${CONSOLE('"state":"accepted","deploymentId":"dep_123"')}
deployment_status() { mkdir -p "$VARDO_DIR/apps/vardo/production/blue"; ln -sfn blue "$VARDO_DIR/apps/vardo/production/current"; echo success; }`;
    const r = sh(vardo, `${deploy}\nAUTO_YES=true\ndo_migrate_self_deploy`, { FAKE_LEGACY: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Vardo deploys itself now.");
    const steps = ["exec vardo-postgres pg_dump", "exec abc123 curl", "stop vardo-frontend"].map((s) => r.docker.indexOf(s));
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(readFileSync(join(vardo, ".env"), "utf8")).toBe("VARDO_ROLE=production\nCOMPOSE_PROFILES=production,buildkit\n");
  });

  it("keeps vardo-frontend while the new console is unhealthy", () => {
    const vardo = instance("self-deploy");
    const r = sh(vardo, "retire_legacy_frontend || echo KEPT", { FAKE_LEGACY: "1", FAKE_HEALTHY: "0" });
    expect(r.out).toContain("Keeping vardo-frontend");
    expect(r.docker).not.toContain("stop vardo-frontend");
  });

  it("retires vardo-frontend with a clean stop once the new console is healthy", () => {
    const vardo = instance("self-deploy");
    const r = sh(vardo, "retire_legacy_frontend", { FAKE_LEGACY: "1" });
    expect(r.docker).toContain("docker stop vardo-frontend");
    expect(r.docker).not.toContain("rm -f vardo-frontend");
    expect(r.docker).not.toMatch(/volume rm vardo_/);
  });
});

describe("the vardo wrapper", () => {
  function wrapper(vardo: string, args: string) {
    sh(vardo, "install_shortcut");
    return sh(vardo, `bash "$VARDO_BIN" ${args}`);
  }

  it("sends update to the serving slot's install.sh on a self-deploy instance", () => {
    expect(wrapper(instance("self-deploy"), "update --yes").out).toContain("SLOT-INSTALL-SH update --yes");
  });

  it("never falls back to the legacy slot's install.sh on a self-deploy instance", () => {
    const vardo = instance("self-deploy");
    rmSync(join(vardo, "apps/vardo/production/blue/install.sh"));
    writeFileSync(join(vardo, "install.sh"), 'echo ROOT-INSTALL-SH "$@"\n');
    expect(wrapper(vardo, "update").out).toContain("ROOT-INSTALL-SH update");
  });

  it("starts containers instead of composing a second console", () => {
    const r = wrapper(instance("self-deploy"), "start");
    expect(r.docker).toMatch(/^docker start/m);
    expect(r.docker).not.toMatch(/docker compose/);
  });

  it("keeps the legacy commands on a legacy instance", () => {
    const vardo = instance("legacy");
    expect(wrapper(vardo, "update").out).toContain("LEGACY-INSTALL-SH update");
    expect(wrapper(vardo, "start").docker).toMatch(/docker compose -f .*env\/current\/docker-compose.yml up -d/);
  });
});
