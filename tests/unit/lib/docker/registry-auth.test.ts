// ---------------------------------------------------------------------------
// Registry credentials reaching a pull.
//
// The credential must arrive through a file the subprocess reads, not through
// argv, which `ps` shows to every user on the host.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, readdir, rm, stat } from "fs/promises";

const { getRegistryCredentials } = vi.hoisted(() => ({
  getRegistryCredentials: vi.fn(async () => ({}) as Record<string, { username: string; password: string }>),
}));

vi.mock("@/lib/docker/image-updates/registry", () => ({ getRegistryCredentials }));

const { buildDockerConfig, registryAuthHint, withRegistryAuth } = await import(
  "@/lib/docker/registry-auth"
);

/** An empty config dir, so a config.json on the machine running the tests is not read. */
let emptyConfigDir: string;
const originalDockerConfig = process.env.DOCKER_CONFIG;

beforeEach(async () => {
  vi.clearAllMocks();
  getRegistryCredentials.mockResolvedValue({});
  const { mkdtemp } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  emptyConfigDir = await mkdtemp(join(tmpdir(), "vardo-test-config-"));
  process.env.DOCKER_CONFIG = emptyConfigDir;
});

afterEach(async () => {
  if (originalDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
  else process.env.DOCKER_CONFIG = originalDockerConfig;
  await rm(emptyConfigDir, { recursive: true, force: true });
});

describe("buildDockerConfig", () => {
  it("writes basic auth Docker understands", () => {
    const config = JSON.parse(
      buildDockerConfig({ "registry.example.test": { username: "svc", password: "s3cret" } }),
    );
    expect(config.auths["registry.example.test"].auth).toBe(
      Buffer.from("svc:s3cret").toString("base64"),
    );
  });

  it("keys Docker Hub by its v1 endpoint", () => {
    const config = JSON.parse(buildDockerConfig({ "docker.io": { username: "u", password: "p" } }));
    expect(Object.keys(config.auths)).toEqual(["https://index.docker.io/v1/"]);
  });

  it("keeps entries from a config an operator mounted", () => {
    const config = JSON.parse(
      buildDockerConfig(
        { "ghcr.io": { username: "u", password: "p" } },
        { "other.example.test": { auth: "bW91bnRlZA==" } },
      ),
    );
    expect(config.auths["other.example.test"].auth).toBe("bW91bnRlZA==");
    expect(config.auths["ghcr.io"].auth).toBe(Buffer.from("u:p").toString("base64"));
  });
});

describe("withRegistryAuth", () => {
  it("passes the environment through untouched when nothing is configured", async () => {
    const env = await withRegistryAuth(async (e) => e);
    expect(env.DOCKER_CONFIG).toBe(emptyConfigDir);
  });

  it("points DOCKER_CONFIG at a config holding the credential", async () => {
    getRegistryCredentials.mockResolvedValue({
      "ghcr.io": { username: "svc", password: "s3cret" },
    });

    const seen = await withRegistryAuth(async (env) => {
      const dir = env.DOCKER_CONFIG!;
      return {
        dir,
        config: JSON.parse(await readFile(`${dir}/config.json`, "utf-8")),
        mode: (await stat(`${dir}/config.json`)).mode & 0o777,
      };
    });

    expect(seen.dir).not.toBe(emptyConfigDir);
    expect(seen.config.auths["ghcr.io"].auth).toBe(Buffer.from("svc:s3cret").toString("base64"));
    expect(seen.mode).toBe(0o600);
  });

  it("removes the config once the command returns", async () => {
    getRegistryCredentials.mockResolvedValue({ "ghcr.io": { username: "u", password: "p" } });

    const dir = await withRegistryAuth(async (env) => env.DOCKER_CONFIG!);

    await expect(readdir(dir)).rejects.toThrow();
  });

  it("removes the config when the command fails", async () => {
    getRegistryCredentials.mockResolvedValue({ "ghcr.io": { username: "u", password: "p" } });
    let dir = "";

    await expect(
      withRegistryAuth(async (env) => {
        dir = env.DOCKER_CONFIG!;
        throw new Error("pull failed");
      }),
    ).rejects.toThrow("pull failed");

    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe("registryAuthHint", () => {
  it("names the registry nothing is configured for", async () => {
    const hint = await registryAuthHint("Error response from daemon: unauthorized", [
      "ghcr.io/acme/api:1.2.3",
    ]);
    expect(hint).toContain("ghcr.io");
    expect(hint).toContain("VARDO_REGISTRY_CREDENTIALS");
  });

  it("stays quiet when the failure was not an auth failure", async () => {
    const hint = await registryAuthHint("manifest for ghcr.io/acme/api:9 not found", [
      "ghcr.io/acme/api:9",
    ]);
    expect(hint).toBeNull();
  });

  it("stays quiet when the registry already has credentials", async () => {
    getRegistryCredentials.mockResolvedValue({ "ghcr.io": { username: "u", password: "p" } });

    const hint = await registryAuthHint("pull access denied", ["ghcr.io/acme/api:1"]);

    expect(hint).toBeNull();
  });

  it("names only the registries that are missing", async () => {
    getRegistryCredentials.mockResolvedValue({ "ghcr.io": { username: "u", password: "p" } });

    const hint = await registryAuthHint("no basic auth credentials", [
      "ghcr.io/acme/api:1",
      "registry.example.test/acme/worker:1",
      undefined,
    ]);

    expect(hint).toContain("registry.example.test");
    expect(hint).not.toContain("ghcr.io");
  });
});
