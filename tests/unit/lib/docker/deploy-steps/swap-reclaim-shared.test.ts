// ---------------------------------------------------------------------------
// An app deployed before its database stopped rotating still runs it in the old
// slot. The shared project is about to start one on the same volume, so the old
// slot goes down first — that overlap is what corrupted GlitchTip's cluster.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock } = vi.hoisted(() => {
  const dbMock = {
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
  };

  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return { dbMock, execFileAsyncMock, execFileMock };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/restart-policy", () => ({
  demoteStandbyRestart: vi.fn().mockResolvedValue(undefined),
  restoreSlotRestart: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/traefik-cutover", () => ({
  clearCutoverPin: vi.fn().mockResolvedValue(undefined),
  guardCutover: vi.fn(async () => ({ pinned: true, release: async () => {} })),
}));
vi.mock("@/lib/docker/client", () => ({ ensureNetwork: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
  getTraefikRoutedServices: vi.fn().mockReturnValue(new Set(["web"])),
}));
vi.mock("@/lib/docker/deploy-steps/bind-mount-ownership", () => ({
  prepareBindMountOwnership: vi.fn().mockResolvedValue(undefined),
  bindMountHostSource: vi.fn(),
  numericUid: vi.fn(),
}));

import { swap } from "@/lib/docker/deploy-steps/swap";
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { ComposeFile } from "@/lib/docker/compose-types";

function calls(): string[][] {
  return execFileAsyncMock.mock.calls.map((c) => c[1] as string[]);
}

/** Index of the first call matching, or -1. */
function indexOf(match: (a: string[]) => boolean): number {
  return calls().findIndex(match);
}

const isOldSlotStop = (a: string[]) => a.includes("app-production-blue") && a.includes("stop");
const isSharedUp = (a: string[]) => a.includes("app-production-shared") && a.includes("up");
const isNewSlotUp = (a: string[]) => a.includes("app-production-green") && a.includes("up");
const isNetworkConnect = (a: string[]) => a[0] === "network" && a[1] === "connect";
const isOldSlotRestore = (a: string[]) =>
  a.includes("app-production-blue") && a.includes("up") && a.includes("--no-recreate");

/** The GlitchTip shape: an unmarked postgres on a top-level named volume. */
function composeFile(): ComposeFile {
  return {
    services: {
      web: { name: "web", image: "nginx", labels: { "traefik.enable": "true" } },
      postgres: {
        name: "postgres",
        image: "postgres:17",
        volumes: ["postgres-data:/var/lib/postgresql/data"],
      },
    },
    volumes: { "postgres-data": {} },
  } as unknown as ComposeFile;
}

function context(overrides: { compose?: ComposeFile; activeSlot?: "blue" | null } = {}): DeployContext {
  const logLines: string[] = [];
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: { id: "app-1", name: "app", healthCheckTimeout: null, domains: [] },
    envName: "production",
    compose: overrides.compose ?? composeFile(),
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/app/production",
    slotDir: "/opt/vardo/apps/app/production/green",
    newProjectName: "app-production-green",
    activeSlot: overrides.activeSlot === undefined ? "blue" : overrides.activeSlot,
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 3000,
    composeFileArgs: ["-f", "docker-compose.yml"],
    logLines,
    logs: { push: (line: string) => logLines.push(line) },
    log: (line: string) => { logLines.push(line); return line; },
    stage: () => {},
    checkAbort: () => {},
    startTime: Date.now(),
  } as unknown as DeployContext;
}

/**
 * Docker answers healthy, and `ps -q` reports whether the old slot still holds
 * the database — the one thing that decides the ordering under test.
 */
function dockerWith(opts: { oldSlotHoldsPostgres: boolean; newSlotHealthy?: boolean }) {
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps") && args.includes("-q")) {
      return { stdout: opts.oldSlotHoldsPostgres ? "abc123\n" : "", stderr: "" };
    }
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({
          Service: "web",
          Name: "app-production-green-web-1",
          State: opts.newSlotHealthy === false ? "exited" : "running",
          Health: opts.newSlotHealthy === false ? "" : "healthy",
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("swap — an app still running its database in the old slot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops the old slot before the shared project starts a second copy", async () => {
    dockerWith({ oldSlotHoldsPostgres: true });
    await swap(context());

    const stop = indexOf(isOldSlotStop);
    const up = indexOf(isSharedUp);
    expect(stop).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(up);
  });

  it("keeps the old slot serving once the database has moved out of it", async () => {
    dockerWith({ oldSlotHoldsPostgres: false });
    await swap(context());

    expect(indexOf(isOldSlotStop)).toBeGreaterThan(indexOf(isNewSlotUp));
  });

  it("brings the database up in the shared project, not the new slot", async () => {
    dockerWith({ oldSlotHoldsPostgres: false });
    await swap(context());

    expect(calls().find(isSharedUp)).toContain("postgres");
    expect(calls().find(isNewSlotUp)).not.toContain("postgres");
  });

  it("checks nothing on a first deploy, where there is no old slot", async () => {
    dockerWith({ oldSlotHoldsPostgres: true });
    await swap(context({ activeSlot: null }));

    expect(indexOf(isOldSlotStop)).toBe(-1);
  });

  it("reattaches the database to the old slot's network when the transition deploy fails", async () => {
    dockerWith({ oldSlotHoldsPostgres: true, newSlotHealthy: false });
    await expect(swap(context())).rejects.toThrow();

    const connect = indexOf(isNetworkConnect);
    expect(calls()[connect]).toEqual([
      "network", "connect", "--alias", "postgres",
      "app-production-blue_default", "app-production-shared-postgres-1",
    ]);
    expect(connect).toBeLessThan(indexOf(isOldSlotRestore));
  });

  it("leaves the network alone when the old slot never held the database", async () => {
    dockerWith({ oldSlotHoldsPostgres: false, newSlotHealthy: false });
    await expect(swap(context())).rejects.toThrow();

    expect(indexOf(isNetworkConnect)).toBe(-1);
  });

  it("does not pin Traefik when the old slot goes down before the new one starts", async () => {
    // There is no second backend to hand traffic to, so guardCutover would only
    // wait out PIN_CONFIRM_TIMEOUT before giving up.
    dockerWith({ oldSlotHoldsPostgres: true });
    const { guardCutover } = await import("@/lib/docker/traefik-cutover");

    await swap(context());
    expect(guardCutover).not.toHaveBeenCalled();
  });

  it("pins Traefik when both slots overlap", async () => {
    dockerWith({ oldSlotHoldsPostgres: false });
    const { guardCutover } = await import("@/lib/docker/traefik-cutover");

    await swap(context());
    expect(guardCutover).toHaveBeenCalled();
  });

  it("leaves an app with nothing shared on the single-project path", async () => {
    dockerWith({ oldSlotHoldsPostgres: true });
    const plain = {
      services: { web: { name: "web", image: "nginx", labels: { "traefik.enable": "true" } } },
    } as unknown as ComposeFile;

    await swap(context({ compose: plain }));
    expect(indexOf(isSharedUp)).toBe(-1);
    expect(indexOf(isOldSlotStop)).toBeGreaterThan(indexOf(isNewSlotUp));
  });
});
