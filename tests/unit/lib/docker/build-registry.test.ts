import { describe, it, expect, vi } from "vitest";

// The build registry: refs derived from app and build key, and pulls that never fail a deploy.

vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: vi.fn(), setSystemSetting: vi.fn() }));

const { parseRegistryUrl, registryOps, registryRef, repoComponent, serviceRepo } = await import("@/lib/docker/build-registry");

const KEY = "f".repeat(64);
const registry = { host: "localhost:5001", prefix: "localhost:5001/vardo", credential: null };

function setup(fail: Partial<Record<"tag" | "push" | "pull" | "rm", string>> = {}) {
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const log: string[] = [];
  const exec = vi.fn(async (_cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push(args);
    envs.push(opts.env as NodeJS.ProcessEnv);
    const verb = args[0] === "image" ? "rm" : (args[0] as "tag" | "push" | "pull");
    if (fail[verb]) throw Object.assign(new Error("exit 1"), { stderr: fail[verb] });
    return { stdout: "" };
  });
  const ops = registryOps(registry, {
    log: (l) => log.push(l),
    exec,
    withAuth: (run) => run({ DOCKER_CONFIG: "/tmp/auth" } as unknown as NodeJS.ProcessEnv),
  });
  return { ops, calls, envs, log };
}

describe("parseRegistryUrl", () => {
  it("accepts a host with an optional port, scheme and namespace", () => {
    expect(parseRegistryUrl("ghcr.io/joeyyax")).toEqual({ host: "ghcr.io", prefix: "ghcr.io/joeyyax" });
    expect(parseRegistryUrl("https://Registry.Example.com:5000/a/b/")).toEqual({
      host: "registry.example.com:5000",
      prefix: "registry.example.com:5000/a/b",
    });
    expect(parseRegistryUrl("localhost:5001")).toEqual({ host: "localhost:5001", prefix: "localhost:5001" });
    expect(parseRegistryUrl("10.0.0.19:5000")).toEqual({ host: "10.0.0.19:5000", prefix: "10.0.0.19:5000" });
  });

  it("refuses a bare name Docker would read as a Docker Hub namespace, and bad paths", () => {
    expect(parseRegistryUrl("joeyyax")).toBeNull();
    expect(parseRegistryUrl("ghcr.io/Owner")).toBeNull();
    expect(parseRegistryUrl("ghcr.io/a b")).toBeNull();
    expect(parseRegistryUrl("")).toBeNull();
  });
});

describe("refs", () => {
  it("names the repo after the app or service and tags it with the build key", () => {
    expect(registryRef(registry, "notes-api", KEY)).toBe(`localhost:5001/vardo/notes-api:${KEY}`);
    expect(registryRef(registry, serviceRepo("shop", "Web_App"), KEY)).toBe(`localhost:5001/vardo/shop-web_app:${KEY}`);
    expect(repoComponent("--A..b__c--")).toBe("a-b-c");
    expect(repoComponent("!!!")).toBe("app");
  });
});

describe("registryOps", () => {
  it("pulls quietly and treats a missing tag as a miss without logging", async () => {
    const hit = setup();
    expect(await hit.ops.pull("localhost:5001/vardo/a:1")).toBe(true);
    expect(hit.calls).toEqual([["pull", "--quiet", "localhost:5001/vardo/a:1"]]);

    const miss = setup({ pull: "Error response from daemon: manifest unknown" });
    expect(await miss.ops.pull("localhost:5001/vardo/a:1")).toBe(false);
    expect(miss.log).toEqual([]);

    const down = setup({ pull: "Error response from daemon: connection refused" });
    expect(await down.ops.pull("localhost:5001/vardo/a:1")).toBe(false);
    expect(down.log[0]).toContain("Couldn't pull");
  });
});
