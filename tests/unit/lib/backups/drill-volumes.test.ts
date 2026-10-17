// A drill's scratch database must leave no volume behind, mocked and against real Docker.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/utils/exec", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/utils/exec")>();
  return { ...real, execFileAsync: (...a: unknown[]) => (execMock.getMockImplementation() ? execMock(...a) : (real.execFileAsync as (...x: unknown[]) => unknown)(...a)) };
});

import { drillScratchDatabase } from "@/lib/backups/drill";
import { scratchDatabaseFor } from "@/lib/backups/drill-plan";

const calls = () => execMock.mock.calls.map((c) => c[1] as string[]);

describe("drill scratch container teardown", () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(async (_cmd: string, argv: string[]) => {
      if (argv[0] === "image") return { stdout: '{"/var/lib/mysql":{}}\n', stderr: "" };
      if (argv[0] === "inspect") return { stdout: "vol-a\n", stderr: "" };
      if (argv[0] === "exec") throw new Error("not ready");
      return { stdout: "", stderr: "" };
    });
  });

  it("removes the container with -v and its volumes by name, and labels what it creates", async () => {
    vi.useFakeTimers();
    const plan = scratchDatabaseFor("mysql", "mysql:8.0", [])!;
    const run = drillScratchDatabase("mysql", plan, "/nope", () => {});
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();

    const argvs = calls();
    const start = argvs.find((a) => a[0] === "run")!;
    expect(start).toContain("vardo.scratch=drill");
    expect(start.join(" ")).toContain("type=volume,target=/var/lib/mysql,volume-label=vardo.scratch=drill");

    const rm = argvs.find((a) => a[0] === "rm")!;
    expect(rm).toEqual(["rm", "-f", "-v", expect.stringMatching(/^vardo-drill-/)]);
    expect(argvs).toContainEqual(["volume", "rm", "-f", "vol-a"]);
  });
});

const IMAGE = "mysql:8.0";
const HAS_IMAGE = (() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const volumes = () => new Set(execFileSync("docker", ["volume", "ls", "-q"], { encoding: "utf8" }).split("\n").filter(Boolean));

describe.skipIf(!HAS_IMAGE)("real Docker drill volumes", () => {
  it("leaves no new volume behind", async () => {
    execMock.mockReset();
    const dir = mkdtempSync(join(tmpdir(), "vardo-drill-vol-"));
    const archive = join(dir, "backup.tar.gz");
    writeFileSync(archive, gzipSync("CREATE DATABASE app; USE app; CREATE TABLE t (id int);\n"));
    try {
      const before = volumes();
      const verdict = await drillScratchDatabase("mysql", scratchDatabaseFor("mysql", IMAGE, [])!, archive, () => {});
      expect(verdict.outcome).toBe("verified");
      expect([...volumes()].filter((v) => !before.has(v))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
