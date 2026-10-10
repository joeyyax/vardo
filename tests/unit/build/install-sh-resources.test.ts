import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { buildkitCacheMaxBytes, buildkitMemGb, installedGiB, redisMemory } from "@/lib/resources/defaults";

// install.sh's sizing must match lib/resources/defaults.ts.

let dir: string;
let lib: string;

function sh(script: string, ramMb: number) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\nget_ram_mb() { echo ${ramMb}; }\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, VARDO_REF: "", VARDO_DIR: join(dir, "absent") },
  });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  return r.stdout;
}

const envOf = (content: string) =>
  Object.fromEntries(content.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=", 2) as [string, string]));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-resources-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Around the installed-GiB rounding, the clamps and the 64 MiB steps of RAM/32.
const RAM_MB = [1900, 2048, 3900, 7800, 7864, 8192, 8355, 8356, 15700, 15800, 16384, 16800, 24575, 24576, 31500, 61440, 62000, 64000, 65536, 98304, 126000, 515000];

describe("install.sh sizing matches lib/resources/defaults.ts", () => {
  it.each(RAM_MB)("%i MB of RAM", (mb) => {
    const file = join(dir, `env-${mb}`);
    writeFileSync(file, "");
    const out = sh(`ensure_redis_mem "${file}" >/dev/null\ncat "${file}"\necho "BUILDKIT=$(default_buildkit_mem)"`, mb);
    const env = envOf(out);
    const { mem, maxmemory } = redisMemory(mb);
    expect(env.VARDO_REDIS_MEM).toBe(mem);
    expect(env.VARDO_REDIS_MAXMEMORY).toBe(maxmemory);
    expect(env.BUILDKIT).toBe(`${buildkitMemGb(mb)}g`);
    expect(sh(`installed_ram_gib`, mb).trim()).toBe(String(installedGiB(mb)));
  });
});

describe("ensure_redis_mem", () => {
  const run = (initial: string, mb: number) => {
    const file = join(dir, `env-run-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, initial);
    sh(`ensure_redis_mem "${file}" >/dev/null`, mb);
    return readFileSync(file, "utf8");
  };

  it("marks the lines it writes as derived", () => {
    expect(run("", 8000)).toContain("# derived: VARDO_REDIS_MEM=512m VARDO_REDIS_MAXMEMORY=320mb\n");
  });

  it("resizes derived values after the host grows", () => {
    const after = run(run("", 8000), 64000);
    expect(envOf(after)).toMatchObject({ VARDO_REDIS_MEM: "2048m", VARDO_REDIS_MAXMEMORY: "1280mb" });
    expect(after).toContain("# derived: VARDO_REDIS_MEM=2048m VARDO_REDIS_MAXMEMORY=1280mb\n");
    expect(after.match(/VARDO_REDIS_MEM=/g)).toHaveLength(2);
  });

  it("leaves values edited since they were derived", () => {
    const edited = run("", 8000).replace("VARDO_REDIS_MEM=512m\n", "VARDO_REDIS_MEM=768m\n");
    expect(run(edited, 64000)).toBe(edited);
  });

  it("leaves values set without a marker", () => {
    const manual = "VARDO_REDIS_MEM=256m\n";
    expect(run(manual, 64000)).toBe(manual);
  });
});

describe("BuildKit cache ceiling", () => {
  const GIB = 1024 ** 3;
  const DISK_GB = [1, 20, 49, 50, 100, 250, 499, 500, 2000];

  it.each(DISK_GB)("matches lib/resources/defaults.ts on a %i GB disk", (gb) => {
    const out = sh(`default_buildkit_cache_bytes ${gb * 1024 * 1024}`, 8192).trim();
    expect(out).toBe(String(buildkitCacheMaxBytes(gb * GIB)));
  });

  it("sizes an eighth of the disk between 5 and 60 GiB, in bytes", () => {
    expect(buildkitCacheMaxBytes(20 * GIB)).toBe(5 * GIB);
    expect(buildkitCacheMaxBytes(250 * GIB)).toBe(31 * GIB);
    expect(buildkitCacheMaxBytes(2000 * GIB)).toBe(60 * GIB);
  });

  it("falls back to 10 GiB when the disk can't be read", () => {
    expect(sh(`get_docker_disk_kb() { echo; }\ndefault_buildkit_cache_bytes`, 8192).trim()).toBe(String(10 * GIB));
  });

  const run = (initial: string) => {
    const file = join(dir, `env-cache-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, initial);
    sh(`get_docker_disk_kb() { echo ${250 * 1024 * 1024}; }\nensure_buildkit_cache_max "${file}" >/dev/null`, 8192);
    return readFileSync(file, "utf8");
  };

  it("writes the ceiling when missing", () => {
    expect(envOf(run("")).VARDO_BUILDKIT_CACHE_MAX).toBe(String(31 * GIB));
  });

  it("raises a value the earlier tenth-of-disk rule derived", () => {
    expect(run(`A=1\nVARDO_BUILDKIT_CACHE_MAX=${25 * GIB}\n`)).toBe(`A=1\nVARDO_BUILDKIT_CACHE_MAX=${31 * GIB}\n`);
  });

  it("keeps a value the owner set", () => {
    expect(run("VARDO_BUILDKIT_CACHE_MAX=20GB\n")).toBe("VARDO_BUILDKIT_CACHE_MAX=20GB\n");
    expect(run(`VARDO_BUILDKIT_CACHE_MAX=${24 * GIB}\n`)).toBe(`VARDO_BUILDKIT_CACHE_MAX=${24 * GIB}\n`);
  });

  it("runs on a self-deploy update", () => {
    const script = readFileSync(join(__dirname, "../../../install.sh"), "utf8");
    const selfUpdate = script.slice(script.indexOf("do_self_update() {"), script.indexOf('step "Redeploying Vardo"'));
    expect(selfUpdate).toContain('ensure_buildkit_cache_max "$VARDO_DIR/.env"');
  });
});

describe("ensure_buildkit_profile", () => {
  const run = (initial: string, exists: boolean) => {
    const file = join(dir, `env-profile-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, initial);
    sh(`docker() { [ "$1 $2" = "inspect vardo-buildkit" ] && ${exists ? "return 0" : "return 1"}; return 1; }\nensure_buildkit_profile "${file}" >/dev/null`, 8192);
    return readFileSync(file, "utf8");
  };

  it("adds buildkit while vardo-buildkit exists", () => {
    expect(run("A=1\nCOMPOSE_PROFILES=production,gpu\n", true)).toBe("A=1\nCOMPOSE_PROFILES=production,gpu,buildkit\n");
  });

  it("leaves profiles alone without the container", () => {
    expect(run("COMPOSE_PROFILES=production\n", false)).toBe("COMPOSE_PROFILES=production\n");
  });

  it("leaves profiles that already include it, or every profile", () => {
    expect(run("COMPOSE_PROFILES=production,buildkit\n", true)).toBe("COMPOSE_PROFILES=production,buildkit\n");
    expect(run("COMPOSE_PROFILES=*\n", true)).toBe("COMPOSE_PROFILES=*\n");
  });

  it("adds nothing when COMPOSE_PROFILES is unset", () => {
    expect(run("A=1\n", true)).toBe("A=1\n");
  });

  it("runs on a self-deploy update", () => {
    const script = readFileSync(join(__dirname, "../../../install.sh"), "utf8");
    const selfUpdate = script.slice(script.indexOf("do_self_update() {"), script.indexOf('step "Redeploying Vardo"'));
    expect(selfUpdate).toContain('ensure_buildkit_profile "$VARDO_DIR/.env"');
  });
});
