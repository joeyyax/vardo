// ---------------------------------------------------------------------------
// A shared service holds the ports every site on the host answers on, so it has
// no second copy to serve during a pull. Its image is fetched while the old
// containers are still up, and a pull that fails must leave them running.
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
vi.mock("@/lib/docker/memory-headroom", () => ({ overlapFitsNow: vi.fn(async () => true) }));
vi.mock("@/lib/docker/deploy-oom", () => ({ reportOomDuringDeploy: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/restart-policy", () => ({
  demoteStandbyRestart: vi.fn(async () => {}),
  restoreSlotRestart: vi.fn(async () => {}),
}));
vi.mock("@/lib/docker/traefik-cutover", () => ({
  clearCutoverPin: vi.fn(async () => {}),
  guardCutover: vi.fn(async () => ({ pinned: true, release: async () => {} })),
}));
vi.mock("@/lib/docker/image-updates/registry", () => ({ getRegistryCredentials: vi.fn(async () => ({})) }));
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

function indexOf(match: (a: string[]) => boolean): number {
  return calls().findIndex(match);
}

const isSharedPull = (a: string[]) => a.includes("pull") && a.includes("app-production-shared");
const isSharedUp = (a: string[]) =>
  a.includes("up") && a.includes("app-production-shared") && !a.includes("--dry-run");
const isOldSlotStop = (a: string[]) => a.includes("stop") && a.includes("app-production-blue");
const isOldSlotRestore = (a: string[]) =>
  a.includes("up") && a.includes("app-production-blue") && a.includes("--no-recreate");
const isImageInspect = (a: string[]) => a[0] === "image" && a[1] === "inspect";

/** A rotating web service in front of a postgres both slots would share. */
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

function context(): DeployContext {
  const logLines: string[] = [];
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: { id: "app-1", name: "app", displayName: "app", healthCheckTimeout: null, domains: [] },
    envName: "production",
    compose: composeFile(),
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/app/production",
    slotDir: "/opt/vardo/apps/app/production/green",
    newProjectName: "app-production-green",
    activeSlot: "blue",
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

type DockerOpts = {
  /** Whether the host already holds postgres:17. */
  imageLocal?: boolean;
  /** Whether the shared pull fails, as a rate-limited registry would. */
  pullFails?: boolean;
  /** Whether the shared `up` fails. */
  sharedUpFails?: boolean;
  /** What a `--dry-run up` reports for the shared containers. */
  dryRun?: string;
  /** Whether the old slot still runs the shared service. */
  oldSlotHoldsShared?: boolean;
};

function dockerWith(opts: DockerOpts = {}) {
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (isImageInspect(args)) {
      if (opts.imageLocal === false) throw new Error("No such image: postgres:17");
      return { stdout: "sha256:abc\n", stderr: "" };
    }
    if (args.includes("--dry-run")) return { stdout: opts.dryRun ?? "", stderr: "" };
    if (isSharedPull(args) && opts.pullFails) {
      throw new Error("toomanyrequests: You have reached your pull rate limit");
    }
    if (isSharedUp(args) && opts.sharedUpFails) {
      throw new Error("Error response from daemon: no such image");
    }
    if (args.includes("ps") && args.includes("-q")) {
      return { stdout: opts.oldSlotHoldsShared ? "abc123\n" : "", stderr: "" };
    }
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({
          Service: "web",
          Name: "app-production-green-web-1",
          State: "running",
          Health: "healthy",
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => vi.clearAllMocks());

describe("swap — fetching shared images", () => {
  it("pulls a missing shared image before the old slot is stopped", async () => {
    dockerWith({ imageLocal: false, oldSlotHoldsShared: true });
    await swap(context());

    expect(indexOf(isSharedPull)).toBeGreaterThan(-1);
    expect(indexOf(isOldSlotStop)).toBeGreaterThan(-1);
    expect(indexOf(isSharedPull)).toBeLessThan(indexOf(isOldSlotStop));
  });

  it("pulls it before the shared project starts", async () => {
    dockerWith({ imageLocal: false });
    await swap(context());

    expect(indexOf(isSharedPull)).toBeLessThan(indexOf(isSharedUp));
  });

  it("leaves the old containers running when the pull fails", async () => {
    dockerWith({ imageLocal: false, pullFails: true, oldSlotHoldsShared: true });

    await expect(swap(context())).rejects.toThrow(/pull rate limit/);
    expect(indexOf(isOldSlotStop)).toBe(-1);
    expect(indexOf(isSharedUp)).toBe(-1);
  });

  it("says the old slot is untouched when the pull fails", async () => {
    dockerWith({ imageLocal: false, pullFails: true });

    await expect(swap(context())).rejects.toThrow(/old slot unaffected/);
  });

  it("does not pull an image the host already holds", async () => {
    dockerWith({ imageLocal: true });
    await swap(context());

    expect(indexOf(isSharedPull)).toBe(-1);
  });

  it("starts the shared project without reaching a registry", async () => {
    dockerWith({ imageLocal: true });
    await swap(context());

    const up = calls().find(isSharedUp)!;
    expect(up.join(" ")).toContain("--pull never");
  });

  it("brings the old slot back when the shared project fails to start", async () => {
    dockerWith({ imageLocal: true, sharedUpFails: true, oldSlotHoldsShared: true });

    await expect(swap(context())).rejects.toThrow(/Shared services failed to start/);
    expect(indexOf(isOldSlotRestore)).toBeGreaterThan(indexOf(isOldSlotStop));
  });

  it("reports a shared service still running an older definition", async () => {
    dockerWith({
      imageLocal: true,
      dryRun: " Container app-production-shared-postgres-1  Recreate ",
    });
    const ctx = context();
    await swap(ctx);

    expect(ctx.logLines).toContainEqual(
      "[deploy] postgres still runs an older definition — a deploy never recreates a shared service, so recreate it to apply the change",
    );
  });

  it("stays quiet when the running definition matches", async () => {
    dockerWith({ imageLocal: true, dryRun: " Container app-production-shared-postgres-1  Running " });
    const ctx = context();
    await swap(ctx);

    expect(ctx.logLines.some((l) => l.includes("older definition"))).toBe(false);
  });
});
