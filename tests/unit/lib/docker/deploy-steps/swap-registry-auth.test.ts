// ---------------------------------------------------------------------------
// The pre-pull runs against the configured registry credentials.
//
// Vardo's container has none of its own, so a private image only resolves if
// the pull subprocess is handed a Docker config that carries them.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  dbMock,
  execFileAsyncMock,
  execFileMock,
  restartPolicyMock,
  cutoverMock,
  inspectImageMeta,
  getRegistryCredentials,
} = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return {
    execFileAsyncMock,
    execFileMock,
    inspectImageMeta: vi.fn(async () => null),
    getRegistryCredentials: vi.fn(
      async () => ({}) as Record<string, { username: string; password: string }>,
    ),
    dbMock: {
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
      query: { deployments: { findFirst: vi.fn(async () => undefined) } },
    },
    restartPolicyMock: {
      demoteStandbyRestart: vi.fn(async () => {}),
      restoreSlotRestart: vi.fn(async () => {}),
    },
    cutoverMock: {
      clearCutoverPin: vi.fn(async () => {}),
      guardCutover: vi.fn(async () => ({ pinned: true, release: async () => {} })),
    },
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/restart-policy", () => restartPolicyMock);
vi.mock("@/lib/docker/traefik-cutover", () => cutoverMock);
vi.mock("@/lib/docker/image-updates/registry", () => ({ getRegistryCredentials }));
vi.mock("@/lib/docker/client", () => ({
  ensureNetwork: vi.fn().mockResolvedValue(undefined),
  inspectImageMeta,
}));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
  getTraefikRoutedServices: vi.fn().mockReturnValue(new Set(["web"])),
}));
vi.mock("@/lib/docker/deploy-steps/bind-mount-ownership", () => ({
  prepareBindMountOwnership: vi.fn().mockResolvedValue(undefined),
  bindMountHostSource: vi.fn(),
  numericUid: vi.fn(),
}));

import { readFile } from "fs/promises";

import { swap } from "@/lib/docker/deploy-steps/swap";
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { ComposeFile } from "@/lib/docker/compose-types";

function composeFile(): ComposeFile {
  return {
    services: {
      web: {
        name: "web",
        image: "registry.example.test/acme/web:1.2.3",
        labels: { "traefik.enable": "true" },
      },
    },
  } as unknown as ComposeFile;
}

function context(): DeployContext {
  const logLines: string[] = [];
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: {
      id: "app-1",
      name: "acme",
      displayName: "Acme",
      deployType: "compose",
      healthCheckTimeout: null,
      domains: [],
    },
    envName: "production",
    compose: composeFile(),
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/acme/production",
    slotDir: "/opt/vardo/apps/acme/production/green",
    newProjectName: "acme-production-green",
    activeSlot: "blue",
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 3000,
    composeFileArgs: ["-f", "docker-compose.yml"],
    logLines,
    logs: { push: (line: string) => logLines.push(line) },
    log: (line: string) => {
      logLines.push(line);
      return line;
    },
    stage: () => {},
    checkAbort: () => {},
    startTime: Date.now(),
  } as unknown as DeployContext;
}

/** The options object each docker invocation was given. */
function optionsFor(command: string): Record<string, unknown> | undefined {
  const call = execFileAsyncMock.mock.calls.find((c) => (c[1] as string[]).includes(command));
  return call?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRegistryCredentials.mockResolvedValue({});
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({
          Service: "web",
          Name: "acme-production-green-web-1",
          State: "running",
          Health: "healthy",
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("swap — registry auth", () => {
  it("hands the pull a Docker config carrying the credential", async () => {
    getRegistryCredentials.mockResolvedValue({
      "registry.example.test": { username: "svc", password: "s3cret" },
    });

    let config = "";
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[], opts: Record<string, string | undefined>) => {
      if (args.includes("pull")) {
        const env = opts.env as unknown as NodeJS.ProcessEnv;
        config = await readFile(`${env.DOCKER_CONFIG}/config.json`, "utf-8");
      }
      if (args.includes("ps")) {
        return {
          stdout: JSON.stringify({
            Service: "web",
            Name: "acme-production-green-web-1",
            State: "running",
            Health: "healthy",
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    await swap(context());

    expect(JSON.parse(config).auths["registry.example.test"].auth).toBe(
      Buffer.from("svc:s3cret").toString("base64"),
    );
  });

  it("keeps the credential off the argument list", async () => {
    getRegistryCredentials.mockResolvedValue({
      "registry.example.test": { username: "svc", password: "s3cret" },
    });

    await swap(context());

    const argv = execFileAsyncMock.mock.calls.flatMap((c) => c[1] as string[]).join(" ");
    expect(argv).not.toContain("s3cret");
    expect(argv).not.toContain("svc");
  });

  it("says which registry has no credentials when the pull is rejected", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("pull")) throw new Error("Error response from daemon: unauthorized");
      return { stdout: "", stderr: "" };
    });

    await expect(swap(context())).rejects.toThrow(
      /No registry credentials are configured for registry\.example\.test/,
    );
  });

  it("leaves the environment alone when no credentials are configured", async () => {
    await swap(context());

    expect(optionsFor("pull")?.env).toBe(process.env);
  });
});
