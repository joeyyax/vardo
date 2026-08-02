import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isSelfApp, seedSelfEnv } from "@/lib/docker/self-env";

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
    await expect(seedSelfEnv("shop", appDir, await slot(), null)).resolves.toBeNull();
  });

  it("copies from the current symlink dir when one exists", async () => {
    const target = await slot();
    const current = join(appDir, "current");
    await mkdir(current, { recursive: true });
    await writeFile(join(current, ".env"), "VARDO_DOMAIN=vardo.example\n");

    await expect(seedSelfEnv("vardo", appDir, target, null)).resolves.toContain("current");
    await expect(readFile(join(target, ".env"), "utf-8")).resolves.toBe("VARDO_DOMAIN=vardo.example\n");
  });

  it("falls back to the active slot when there is no current symlink", async () => {
    const target = await slot();
    const green = join(appDir, "green");
    await mkdir(green, { recursive: true });
    await writeFile(join(green, ".env"), "VARDO_DOMAIN=from-green\n");

    await expect(seedSelfEnv("vardo", appDir, target, "green")).resolves.toContain("green");
    await expect(readFile(join(target, ".env"), "utf-8")).resolves.toBe("VARDO_DOMAIN=from-green\n");
  });

  it("falls back to the pre-migration env/ layout, which is live until the first engine deploy", async () => {
    const target = await slot();
    const legacy = join(root, "vardo", "env", "current");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, ".env"), "VARDO_DOMAIN=from-legacy\n");

    await expect(seedSelfEnv("vardo", appDir, target, null)).resolves.toContain("env");
    await expect(readFile(join(target, ".env"), "utf-8")).resolves.toBe("VARDO_DOMAIN=from-legacy\n");
  });

  it("returns null rather than writing an empty file when nothing is found", async () => {
    const target = await slot();
    await expect(seedSelfEnv("vardo", appDir, target, null)).resolves.toBeNull();
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

      await expect(seedSelfEnv("vardo", appDir, target, "green")).resolves.toContain("green");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
