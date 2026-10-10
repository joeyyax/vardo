import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { parse } from "yaml";

// scripts/watchdog.sh: the decision is a pure shell function; a tick runs against a fake docker.

const SCRIPT = join(__dirname, "../../../scripts/watchdog.sh");

let dir: string;

function sh(body: string, env: Record<string, string> = {}) {
  const r = spawnSync("sh", ["-c", `. "${SCRIPT}"\n${body}`], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      WATCHDOG_SOURCE_ONLY: "1",
      WATCHDOG_STATE_DIR: join(dir, "state"),
      WATCHDOG_APP_DIR: join(dir, "app"),
      FAKE: join(dir, "fake"),
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  return r.stdout;
}

const decide = (kind: string, health: string, fails: number, recent: number, deploy: string) =>
  sh(`decide ${kind} ${health} ${fails} ${recent} ${deploy}`).trim();

const FAKE_DOCKER = `#!/bin/sh
F="$FAKE"
case "$1" in
  inspect)
    for last; do :; done
    case "$3" in
      *Name*) echo "/vardo-production-green-frontend-1" ;;
      *) cat "$F/state/$last" 2>/dev/null || exit 1 ;;
    esac ;;
  ps) case "$*" in *vardo-production-green*) echo abc123 ;; esac ;;
  exec)
    case "$*" in
      *backup:busy*) cat "$F/backups" 2>/dev/null || echo 0 ;;
      *) [ -f "$F/deploy" ] || exit 1; cat "$F/deploy" ;;
    esac ;;
  restart) echo "$4" >> "$F/restarts" ;;
esac
`;

function setState(name: string, value: string) {
  writeFileSync(join(dir, "fake/state", name), `${value}\n`);
}

const restarts = () =>
  existsSync(join(dir, "fake/restarts")) ? readFileSync(join(dir, "fake/restarts"), "utf8").trim().split("\n") : [];

const events = () =>
  existsSync(join(dir, "state/events.log"))
    ? readFileSync(join(dir, "state/events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

const ticks = (n: number) => sh(Array(n).fill("tick").join("\n"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "watchdog-"));
  for (const d of ["bin", "state", "fake/state", "app/production"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "bin/docker"), FAKE_DOCKER);
  chmodSync(join(dir, "bin/docker"), 0o755);
  writeFileSync(join(dir, "fake/deploy"), "0\n");
  for (const name of ["vardo-production-green-frontend-1", "vardo-traefik", "vardo-postgres", "vardo-redis"]) {
    setState(name, "running healthy");
  }
  symlinkSync("green", join(dir, "app/production/current"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("decide", () => {
  it("resets on a healthy check", () => {
    expect(decide("app", "healthy", 2, 0, "idle")).toBe("ok 0");
    expect(decide("app", "starting", 2, 0, "idle")).toBe("ok 0");
    expect(decide("app", "none", 2, 0, "idle")).toBe("ok 0");
  });

  it("restarts an app container on the third consecutive failure", () => {
    expect(decide("app", "unhealthy", 0, 0, "idle")).toBe("wait 1");
    expect(decide("app", "unhealthy", 1, 0, "idle")).toBe("wait 2");
    expect(decide("app", "unhealthy", 2, 0, "idle")).toBe("restart 0");
  });

  it("gives data stores a longer window", () => {
    expect(decide("data", "unhealthy", 0, 0, "idle")).toBe("wait 1");
    expect(decide("data", "unhealthy", 2, 0, "idle")).toBe("wait 3");
    expect(decide("data", "unhealthy", 8, 0, "idle")).toBe("wait 9");
    expect(decide("data", "unhealthy", 9, 0, "idle")).toBe("restart 0");
  });

  it("never acts during a deploy and starts counting over after it", () => {
    expect(decide("app", "unhealthy", 5, 0, "active")).toBe("deploy 0");
    expect(decide("data", "unhealthy", 20, 0, "active")).toBe("deploy 0");
  });

  it("holds app containers when the deploy state is unreadable, not data stores", () => {
    expect(decide("app", "unhealthy", 5, 0, "unknown")).toBe("unknown 6");
    expect(decide("data", "unhealthy", 9, 0, "unknown")).toBe("restart 0");
    expect(decide("data", "unhealthy", 0, 0, "unknown")).toBe("wait 1");
  });

  it("backs off after three restarts in the window", () => {
    expect(decide("app", "unhealthy", 2, 2, "idle")).toBe("restart 0");
    expect(decide("app", "unhealthy", 2, 3, "idle")).toBe("backoff 3");
    expect(decide("data", "unhealthy", 9, 3, "idle")).toBe("backoff 10");
  });

  it("holds a restart while backup work runs, then restarts once the hold ends", () => {
    expect(decide("app", "unhealthy", 1, 0, "idle hold")).toBe("wait 2");
    expect(decide("app", "unhealthy", 2, 0, "idle hold")).toBe("backups 3");
    expect(decide("app", "unhealthy", 7, 0, "idle hold")).toBe("backups 8");
    expect(decide("app", "unhealthy", 7, 0, "idle expired")).toBe("restart 0");
  });

  it("honors the thresholds from the environment", () => {
    expect(sh("decide app unhealthy 0 0 idle", { WATCHDOG_APP_FAILS: "1" }).trim()).toBe("restart 0");
    expect(sh("decide app unhealthy 2 1 idle", { WATCHDOG_MAX_RESTARTS: "1" }).trim()).toBe("backoff 3");
  });
});

describe("tick", () => {
  it("restarts Traefik after three unhealthy checks and records it", () => {
    setState("vardo-traefik", "running unhealthy");
    ticks(2);
    expect(restarts()).toEqual([]);
    ticks(1);
    expect(restarts()).toEqual(["vardo-traefik"]);
    expect(events()).toMatchObject([{ role: "traefik", container: "vardo-traefik", action: "restart", fails: 3 }]);
  });

  it("finds the console through the current symlink", () => {
    setState("vardo-production-green-frontend-1", "running unhealthy");
    ticks(3);
    expect(restarts()).toEqual(["vardo-production-green-frontend-1"]);
  });

  it("falls back to vardo-frontend without a self-deployed slot", () => {
    rmSync(join(dir, "app/production/current"));
    setState("vardo-frontend", "running unhealthy");
    ticks(3);
    expect(restarts()).toEqual(["vardo-frontend"]);
  });

  it("leaves a stopped container to Docker's restart policy", () => {
    setState("vardo-traefik", "exited unhealthy");
    ticks(5);
    expect(restarts()).toEqual([]);
  });

  it("does nothing while a deploy holds a lease", () => {
    setState("vardo-traefik", "running unhealthy");
    writeFileSync(join(dir, "fake/deploy"), "1\n");
    ticks(5);
    expect(restarts()).toEqual([]);
    writeFileSync(join(dir, "fake/deploy"), "0\n");
    ticks(2);
    expect(restarts()).toEqual([]);
    ticks(1);
    expect(restarts()).toEqual(["vardo-traefik"]);
  });

  it("holds an unhealthy console while it runs backup work, up to WATCHDOG_BACKUP_HOLD", () => {
    setState("vardo-production-green-frontend-1", "running unhealthy");
    writeFileSync(join(dir, "fake/backups"), "1\n");
    ticks(5);
    expect(restarts()).toEqual([]);

    // The hold started 30 minutes ago.
    writeFileSync(join(dir, "state/console.backup-hold"), `${Math.floor(Date.now() / 1000) - 1800}\n`);
    ticks(1);
    expect(restarts()).toEqual(["vardo-production-green-frontend-1"]);
  });

  it("restarts the console once its backup work finishes", () => {
    setState("vardo-production-green-frontend-1", "running unhealthy");
    writeFileSync(join(dir, "fake/backups"), "1\n");
    ticks(4);
    writeFileSync(join(dir, "fake/backups"), "0\n");
    ticks(1);
    expect(restarts()).toEqual(["vardo-production-green-frontend-1"]);
  });

  it("does not hold Traefik for backup work", () => {
    setState("vardo-traefik", "running unhealthy");
    writeFileSync(join(dir, "fake/backups"), "1\n");
    ticks(3);
    expect(restarts()).toEqual(["vardo-traefik"]);
  });

  it("restarts only data stores when Redis can't be read", () => {
    rmSync(join(dir, "fake/deploy"));
    setState("vardo-traefik", "running unhealthy");
    setState("vardo-redis", "running unhealthy");
    ticks(9);
    expect(restarts()).toEqual([]);
    ticks(1);
    expect(restarts()).toEqual(["vardo-redis"]);
  });

  it("stops after three restarts in the window and records the backoff once", () => {
    setState("vardo-traefik", "running unhealthy");
    ticks(15);
    expect(restarts()).toEqual(["vardo-traefik", "vardo-traefik", "vardo-traefik"]);
    expect(events().map((e) => e.action)).toEqual(["restart", "restart", "restart", "backoff"]);
  });

  it("restarts again once the window has passed", () => {
    setState("vardo-traefik", "running unhealthy");
    writeFileSync(join(dir, "state/traefik.restarts"), "1\n2\n3\n");
    ticks(3);
    expect(restarts()).toEqual(["vardo-traefik"]);
  });

  it("pauses while the pause file exists", () => {
    setState("vardo-traefik", "running unhealthy");
    writeFileSync(join(dir, "state/pause"), "");
    ticks(5);
    expect(restarts()).toEqual([]);
  });

  it("idles when VARDO_WATCHDOG=false", () => {
    writeFileSync(join(dir, "bin/sleep"), "#!/bin/sh\necho slept\n");
    chmodSync(join(dir, "bin/sleep"), 0o755);
    const out = sh("main", { VARDO_WATCHDOG: "false" });
    expect(out).toContain("disabled by VARDO_WATCHDOG=false");
    expect(out).toContain("slept");
  });
});

describe("compose", () => {
  const compose = parse(readFileSync(join(__dirname, "../../../docker-compose.yml"), "utf8"));

  it("runs the watchdog as a shared production service outside the console", () => {
    const svc = compose.services.watchdog;
    expect(svc.profiles).toEqual(["production"]);
    expect(svc["x-vardo-shared"]).toBe(true);
    expect(svc.build).toBeUndefined();
    expect(svc.image).toMatch(/^docker:\d+\.\d+\.\d+-cli$/);
    expect(svc.volumes).toContain("./scripts/watchdog.sh:/usr/local/bin/vardo-watchdog:ro");
    expect(svc.depends_on).toBeUndefined();
  });

  it("gives BuildKit a healthcheck", () => {
    expect(compose.services.buildkit.healthcheck.test).toEqual(["CMD", "buildctl", "debug", "workers"]);
  });
});
