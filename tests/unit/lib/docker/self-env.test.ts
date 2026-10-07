import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isSelfApp, mergeSelfEnv, seedSelfEnv } from "@/lib/docker/self-env";

const noGlobal = { log: () => {}, globalEnvPath: "/nonexistent/vardo/.env" };

describe("isSelfApp", () => {
  it("is true only for Vardo's own app record", () => {
    expect(isSelfApp("vardo")).toBe(true);
    expect(isSelfApp("vardo-postgres")).toBe(false);
    expect(isSelfApp("shop")).toBe(false);
  });
});

describe("seedSelfEnv", () => {
  let root: string;
  let appDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "self-env-"));
    appDir = join(root, "vardo", "production");
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function slot(): Promise<string> {
    const dir = join(appDir, "blue");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("does nothing for an ordinary app, whose env comes from the database", async () => {
    await expect(seedSelfEnv("shop", appDir, await slot(), null, noGlobal)).resolves.toBeNull();
  });

  it("copies from the current symlink dir when one exists", async () => {
    const target = await slot();
    const current = join(appDir, "current");
    await mkdir(current, { recursive: true });
    await writeFile(join(current, ".env"), "VARDO_DOMAIN=vardo.example\n");

    await expect(seedSelfEnv("vardo", appDir, target, null, noGlobal)).resolves.toContain("current");
    await expect(readFile(join(target, ".env"), "utf-8")).resolves.toBe("VARDO_DOMAIN=vardo.example\n");
  });

  it("falls back to the active slot when there is no current symlink", async () => {
    const target = await slot();
    const green = join(appDir, "green");
    await mkdir(green, { recursive: true });
    await writeFile(join(green, ".env"), "VARDO_DOMAIN=from-green\n");

    await expect(seedSelfEnv("vardo", appDir, target, "green", noGlobal)).resolves.toContain("green");
    await expect(readFile(join(target, ".env"), "utf-8")).resolves.toBe("VARDO_DOMAIN=from-green\n");
  });

  it("falls back to the pre-migration env/ layout, which is live until the first engine deploy", async () => {
    const target = await slot();
    const legacy = join(root, "vardo", "env", "current");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, ".env"), "VARDO_DOMAIN=from-legacy\n");

    await expect(seedSelfEnv("vardo", appDir, target, null, noGlobal)).resolves.toContain("env");
    await expect(readFile(join(target, ".env"), "utf-8")).resolves.toBe("VARDO_DOMAIN=from-legacy\n");
  });

  it("returns null rather than writing an empty file when nothing is found", async () => {
    const target = await slot();
    await expect(seedSelfEnv("vardo", appDir, target, null, noGlobal)).resolves.toBeNull();
    await expect(readFile(join(target, ".env"), "utf-8")).rejects.toThrow();
  });
});

describe("seedSelfEnv when the source is unreadable", () => {
  it("skips a missing candidate and takes the next one", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-env-fallback-"));
    try {
      const appDir = join(root, "vardo", "production");
      const target = join(appDir, "blue");
      await mkdir(target, { recursive: true });
      // No `current`, so the active slot is the only readable candidate.
      const green = join(appDir, "green");
      await mkdir(green, { recursive: true });
      await writeFile(join(green, ".env"), "VARDO_DOMAIN=from-green\n");

      await expect(seedSelfEnv("vardo", appDir, target, "green", noGlobal)).resolves.toContain("green");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("mergeSelfEnv", () => {
  it("adds keys that only the global file has", () => {
    const merged = mergeSelfEnv("A=1\nVARDO_BUILDKIT_MEM=12g\n", "A=1\n");
    expect(merged.added).toEqual(["VARDO_BUILDKIT_MEM"]);
    expect(merged.content).toBe("A=1\nVARDO_BUILDKIT_MEM=12g\n");
  });

  it("takes the global value when both files set a key", () => {
    const merged = mergeSelfEnv("VARDO_BUILDKIT_MEM=12g\n", "VARDO_BUILDKIT_MEM=4g\n");
    expect(merged.changed).toEqual(["VARDO_BUILDKIT_MEM"]);
    expect(merged.content).toBe("VARDO_BUILDKIT_MEM=12g\n");
  });

  it("treats quoting differences as the same value", () => {
    expect(mergeSelfEnv('A="x y"\n', "A='x y'\n").changed).toEqual([]);
  });

  it("keeps slot-owned keys from the previous slot", () => {
    const merged = mergeSelfEnv("GIT_SHA=aaaaaaa\nB=2\n", "GIT_SHA=bbbbbbb\nCOMPOSE_PROJECT_NAME=vardo-production-blue\n");
    expect(merged.changed).toEqual([]);
    expect(merged.content).toContain("GIT_SHA=bbbbbbb");
    expect(merged.content).not.toContain("aaaaaaa");
    expect(merged.content).toContain("COMPOSE_PROJECT_NAME=vardo-production-blue");
    expect(merged.carried).toEqual([]);
  });

  it("carries keys the global file lacks", () => {
    const merged = mergeSelfEnv("# settings\nA=1\n", "A=1\nHAND_SET=x\n");
    expect(merged.carried).toEqual(["HAND_SET"]);
    expect(merged.content).toBe("# settings\nA=1\n\n# From the previous slot\nHAND_SET=x\n");
  });
});

describe("seedSelfEnv with a global .env", () => {
  let root: string;
  let appDir: string;
  let globalEnvPath: string;
  let lines: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "self-env-global-"));
    appDir = join(root, "apps", "vardo", "production");
    globalEnvPath = join(root, ".env");
    lines = [];
    await mkdir(join(appDir, "blue"), { recursive: true });
    await mkdir(join(appDir, "current"), { recursive: true });
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("builds the slot from the global file and logs key names only", async () => {
    await writeFile(globalEnvPath, "ENCRYPTION_MASTER_KEY=new-secret\nVARDO_BUILDKIT_MEM=12g\n");
    await writeFile(join(appDir, "current", ".env"), "ENCRYPTION_MASTER_KEY=old-secret\nGIT_SHA=abc1234\n");

    const source = await seedSelfEnv("vardo", appDir, join(appDir, "blue"), null, {
      log: (line) => lines.push(line),
      globalEnvPath,
    });

    expect(source).toContain(globalEnvPath);
    const written = await readFile(join(appDir, "blue", ".env"), "utf-8");
    expect(written).toContain("ENCRYPTION_MASTER_KEY=new-secret");
    expect(written).toContain("VARDO_BUILDKIT_MEM=12g");
    expect(written).toContain("GIT_SHA=abc1234");

    const logged = lines.join("\n");
    expect(logged).toContain("ENCRYPTION_MASTER_KEY differs");
    expect(logged).toContain("added from");
    expect(logged).toContain("VARDO_BUILDKIT_MEM");
    for (const value of ["new-secret", "old-secret", "12g", "abc1234"]) {
      expect(logged).not.toContain(value);
    }
  });

  it("uses the global file alone when there is no previous slot", async () => {
    await rm(join(appDir, "current"), { recursive: true });
    await writeFile(globalEnvPath, "A=1\n");

    await expect(
      seedSelfEnv("vardo", appDir, join(appDir, "blue"), null, { log: (l) => lines.push(l), globalEnvPath }),
    ).resolves.toBe(globalEnvPath);
    await expect(readFile(join(appDir, "blue", ".env"), "utf-8")).resolves.toBe("A=1\n");
    expect(lines).toEqual([]);
  });
});
