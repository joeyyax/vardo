import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// vardo doctor reads the self-deploy layout: shared services in project vardo, the console in vardo-production-<slot>.

let dir: string;
let lib: string;
let bin: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
args="$*"
case "$args" in
  "--version") echo "Docker version 27.0.0, build x" ;;
  "compose version"*) echo "Docker Compose version v2.29.0" ;;
  "info"*) exit 0 ;;
  "ps -a --filter label=com.docker.compose.project=vardo --format"*)
    printf 'vardo-postgres\\tUp 2 days (healthy)\\nvardo-redis\\tUp 2 days (healthy)\\nvardo-traefik\\tUp 2 days\\n' ;;
  "ps -a --filter label=com.docker.compose.project=vardo-production-"*)
    [ -z "\${FAKE_NO_CONSOLE:-}" ] && printf "vardo-production-blue-frontend-1\\tUp 3 hours (\${FAKE_CONSOLE_HEALTH:-healthy})\\n" ;;
  "ps -q --filter label=com.docker.compose.project=vardo-production-"*) [ -z "\${FAKE_NO_CONSOLE:-}" ] && echo abc123 ;;
  "ps --filter label=com.docker.compose.service=frontend"*)
    echo "vardo-production-blue-frontend-1 vardo-production-blue"
    [ -z "\${FAKE_TWO_SLOTS:-}" ] || echo "vardo-production-green-frontend-1 vardo-production-green" ;;
  "ps -q --filter name=^vardo-frontend\\$"*) [ -z "\${FAKE_LEGACY:-}" ] || echo legacy1 ;;
  "exec vardo-postgres pg_isready"*) exit 0 ;;
  "exec vardo-redis"*) echo PONG ;;
  "exec abc123 curl"*) exit 0 ;;
  "compose "*) exit 1 ;;
esac
exit 0
`;

function instance(): string {
  const vardo = mkdtempSync(join(dir, "self-deploy-"));
  writeFileSync(join(vardo, ".env"), "VARDO_ROLE=production\n");
  mkdirSync(join(vardo, "apps/vardo/production/blue"), { recursive: true });
  symlinkSync("blue", join(vardo, "apps/vardo/production/current"));
  return vardo;
}

function doctor(vardo: string, env: Record<string, string> = {}) {
  const log = join(vardo, "docker.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", ["-c", `source "${lib}"\nPLATFORM=macos\ndo_doctor`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VARDO_DIR: vardo, DOCKER_LOG: log, ...env },
  });
  return { out: `${r.stdout}${r.stderr}`, docker: readFileSync(log, "utf8") };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-doctor-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  // No DNS or TLS lookups from a test.
  for (const tool of ["dig", "host", "curl"]) {
    writeFileSync(join(bin, tool), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(bin, tool), 0o755);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vardo doctor on a self-deploy instance", { timeout: 30_000 }, () => {
  it("checks the shared services and the slot console, never the legacy compose project", () => {
    const r = doctor(instance());
    expect(r.out).toContain("Self-deploy: blue active");
    expect(r.out).toContain("vardo-postgres — healthy");
    expect(r.out).toContain("vardo-traefik — running (no healthcheck)");
    expect(r.out).toContain("vardo-production-blue-frontend-1 — healthy");
    expect(r.out).toContain("PostgreSQL: accepting connections");
    expect(r.out).toContain("Redis: PONG");
    expect(r.out).toContain("App: /api/health OK (blue)");
    expect(r.docker).not.toMatch(/docker compose -f/);
  });

  it("fails when production/current points at a slot with no console", () => {
    const r = doctor(instance(), { FAKE_NO_CONSOLE: "1" });
    expect(r.out).toContain("No console in vardo-production-blue");
    expect(r.out).toContain("App: /api/health unreachable");
  });

  it("reports an unhealthy console as failed", () => {
    const r = doctor(instance(), { FAKE_CONSOLE_HEALTH: "unhealthy" });
    expect(r.out).toMatch(/✗.*vardo-production-blue-frontend-1 — Up 3 hours \(unhealthy\)/);
  });

  it("warns about a second slot console and a legacy console still running", () => {
    const r = doctor(instance(), { FAKE_TWO_SLOTS: "1", FAKE_LEGACY: "1" });
    expect(r.out).toContain("2 slot consoles running; only blue should be");
    expect(r.out).toContain("Legacy vardo-frontend still running");
  });
});
