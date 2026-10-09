import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { buildkitCacheMaxBytes, buildkitMemGb, redisMemory } from "@/lib/resources/defaults";

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

const RAM_MB = [1900, 2048, 3900, 7800, 8192, 15800, 24575, 24576, 31500, 64000, 98303, 98304, 126000, 515000];

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
    expect(run("", 8000)).toContain("# derived: VARDO_REDIS_MEM=512m VARDO_REDIS_MAXMEMORY=384mb\n");
  });

  it("resizes derived values after the host grows", () => {
    const after = run(run("", 8000), 64000);
    expect(envOf(after)).toMatchObject({ VARDO_REDIS_MEM: "1024m", VARDO_REDIS_MAXMEMORY: "768mb" });
    expect(after).toContain("# derived: VARDO_REDIS_MEM=1024m VARDO_REDIS_MAXMEMORY=768mb\n");
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

  it("sizes a tenth of the disk between 5 and 50 GiB, in bytes", () => {
    expect(buildkitCacheMaxBytes(20 * GIB)).toBe(5 * GIB);
    expect(buildkitCacheMaxBytes(250 * GIB)).toBe(25 * GIB);
    expect(buildkitCacheMaxBytes(2000 * GIB)).toBe(50 * GIB);
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

  it("writes the ceiling once", () => {
    expect(envOf(run("")).VARDO_BUILDKIT_CACHE_MAX).toBe(String(25 * GIB));
  });

  it("keeps a value the owner set", () => {
    expect(run("VARDO_BUILDKIT_CACHE_MAX=20GB\n")).toBe("VARDO_BUILDKIT_CACHE_MAX=20GB\n");
  });
});
