import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { dockerEnv } from "@/lib/docker/docker-env";
import { execFileAsync } from "@/lib/utils/exec";

const SECRET = "console-secret-value";

describe("dockerEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/app",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    BUILDKIT_HOST: "tcp://vardo-buildkit:1234",
    LC_ALL: "C.UTF-8",
    VARDO_LOKI_MEM: "2g",
    ENCRYPTION_MASTER_KEY: SECRET,
    BETTER_AUTH_SECRET: SECRET,
    DATABASE_URL: "postgres://host",
    CF_DNS_API_TOKEN: SECRET,
    VARDO_REGISTRY_CREDENTIALS: SECRET,
    COMPOSE_PROFILES: "production",
    DOCKER_GID: "999",
    NODE_ENV: "production",
    PORT: "3000",
  } as NodeJS.ProcessEnv;

  it("keeps only what Docker needs", () => {
    expect(dockerEnv({}, source)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/app",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      BUILDKIT_HOST: "tcp://vardo-buildkit:1234",
      LC_ALL: "C.UTF-8",
      VARDO_LOKI_MEM: "2g",
    });
  });

  it("layers extra on top and skips undefined", () => {
    const env = dockerEnv({ DOCKER_CONFIG: "/tmp/cfg", PATH: undefined }, source);
    expect(env.DOCKER_CONFIG).toBe("/tmp/cfg");
    expect(env.PATH).toBe("/usr/bin");
  });
});

function hasCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { env: dockerEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasCompose())("docker compose interpolation", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vardo-docker-env-"));
    await writeFile(
      join(dir, "docker-compose.yml"),
      [
        "services:",
        "  app:",
        "    image: alpine",
        "    environment:",
        '      LEAK: "${ENCRYPTION_MASTER_KEY:-}"',
        '      OWN: "${DATABASE_URL:-}"',
        "",
      ].join("\n"),
    );
    await writeFile(join(dir, ".env"), "DATABASE_URL=app-own\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function resolved(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
    const { stdout } = await execFileAsync("docker", ["compose", "config", "--format", "json"], {
      cwd: dir,
      env,
      encoding: "utf-8",
    });
    return JSON.parse(String(stdout)).services.app.environment;
  }

  it("leaks the console env without the helper", async () => {
    vi.stubEnv("ENCRYPTION_MASTER_KEY", SECRET);
    vi.stubEnv("DATABASE_URL", "console-db");
    const env = await resolved(process.env);
    expect(env.LEAK).toBe(SECRET);
    expect(env.OWN).toBe("console-db");
  });

  it("resolves console secrets empty and the app's .env intact with the helper", async () => {
    vi.stubEnv("ENCRYPTION_MASTER_KEY", SECRET);
    vi.stubEnv("DATABASE_URL", "console-db");
    const env = await resolved(dockerEnv());
    expect(env.LEAK).toBe("");
    expect(env.OWN).toBe("app-own");
  });
});
