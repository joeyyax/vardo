import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { generateNixpacksDockerfile, planVariables } from "@/lib/docker/nixpacks-dockerfile";
import { nixpacksGenerateArgs } from "@/lib/docker/buildpack-args";

// Nixpacks writes its Dockerfile into the build tree; Vardo builds it like any Dockerfile, or falls back.

let src: string;
let calls: string[][];

const exists = (p: string) => stat(p).then(() => true, () => false);

beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), "nixpacks-"));
  calls = [];
});

afterEach(async () => {
  await rm(src, { recursive: true, force: true });
});

/** Stands in for Nixpacks 1.41: `plan` prints JSON, `build --out` writes `.nixpacks/`. */
function fakeNixpacks(plan: string) {
  return async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "plan") return { stdout: plan };
    await mkdir(join(src, ".nixpacks"), { recursive: true });
    await writeFile(join(src, ".nixpacks", "Dockerfile"), "FROM ghcr.io/railwayapp/nixpacks:ubuntu\n");
    return { stdout: "Saved output to:\n" };
  };
}

describe("generateNixpacksDockerfile", () => {
  it("returns the generated Dockerfile and the plan's variables as build args", async () => {
    const plan = JSON.stringify({ variables: { NODE_ENV: "production", API: "https://api.example.com" } });
    const out = await generateNixpacksDockerfile({
      source: src,
      cacheKey: "app-1",
      envVars: { API: "https://api.example.com" },
      overrides: { buildCommand: "npm run build:prod" },
      log: () => {},
      exec: fakeNixpacks(plan),
    });

    expect(out).toEqual({
      dockerfile: join(src, ".nixpacks", "Dockerfile"),
      buildArgs: { NODE_ENV: "production", API: "https://api.example.com" },
    });
    expect(calls[1]).toEqual(nixpacksGenerateArgs(src, "app-1", { API: "https://api.example.com" }, { buildCommand: "npm run build:prod" }));
  });

  it("clears a stale .nixpacks before generating", async () => {
    await mkdir(join(src, ".nixpacks"), { recursive: true });
    await writeFile(join(src, ".nixpacks", "old.nix"), "stale");
    await generateNixpacksDockerfile({ source: src, cacheKey: "a", log: () => {}, exec: fakeNixpacks('{"variables":{}}') });
    expect(await exists(join(src, ".nixpacks", "old.nix"))).toBe(false);
  });

  it("falls back, without echoing argv, when Nixpacks fails", async () => {
    const lines: string[] = [];
    const out = await generateNixpacksDockerfile({
      source: src,
      cacheKey: "a",
      envVars: { TOKEN: "secret" },
      log: (l) => lines.push(l),
      exec: async () => {
        throw Object.assign(new Error("Command failed: nixpacks plan --env TOKEN=secret"), { code: 1, stderr: "Error: no provider\n" });
      },
    });

    expect(out).toBeNull();
    expect(lines).toEqual(["[build] Couldn't generate the Nixpacks Dockerfile, building with Nixpacks directly: Error: no provider"]);
  });

  it("falls back when the plan has no variables or no Dockerfile appears", async () => {
    const lines: string[] = [];
    expect(await generateNixpacksDockerfile({ source: src, cacheKey: "a", log: (l) => lines.push(l), exec: fakeNixpacks("[]") })).toBeNull();
    expect(lines[0]).toMatch(/plan has no variables$/);

    const noFile = async (_c: string, args: string[]) => ({ stdout: args[0] === "plan" ? '{"variables":{}}' : "" });
    expect(await generateNixpacksDockerfile({ source: src, cacheKey: "a", log: () => {}, exec: noFile })).toBeNull();
  });

  it("rethrows when the deploy was cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      generateNixpacksDockerfile({
        source: src,
        cacheKey: "a",
        log: () => {},
        signal: ac.signal,
        exec: async () => { throw new Error("aborted"); },
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("planVariables", () => {
  it("stringifies values and rejects plans without a variables map", () => {
    expect(planVariables('{"variables":{"PORT":3000}}')).toEqual({ PORT: "3000" });
    expect(planVariables('{"variables":[]}')).toBeNull();
    expect(planVariables("{}")).toBeNull();
  });
});
