// ---------------------------------------------------------------------------
// Vardo deploying itself: the new slot's worker starts with its frontend and
// gates the deploy on its health; the old slot's worker drains on its own
// before the slot-wide stop ends the process running the deploy.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const { execFileAsyncMock, execFileMock } = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });
  return { execFileAsyncMock, execFileMock };
});

vi.mock("ioredis", async () => (await import("@/tests/helpers/mocks")).ioredisModule());
vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })) } }));
vi.mock("@/lib/docker/memory-headroom", () => ({ overlapFitsNow: vi.fn(async () => true) }));
vi.mock("@/lib/docker/restart-policy", () => ({ demoteStandbyRestart: vi.fn(async () => {}), restoreSlotRestart: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/traefik-cutover", () => ({
  clearCutoverPin: vi.fn(async () => {}),
  holdSlot: vi.fn(async () => ({ held: false, release: async () => {} })),
  NO_HOLD: { held: false, release: async () => {} },
  guardCutover: vi.fn(async () => ({ pinned: true, release: async () => {} })),
}));
vi.mock("@/lib/docker/deploy-steps/volume-limits", () => ({ checkVolumeLimits: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/client", () => ({ ensureNetwork: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
  getTraefikRoutedServices: vi.fn().mockReturnValue(new Set(["frontend"])),
}));
vi.mock("@/lib/docker/deploy-steps/bind-mount-ownership", () => ({
  prepareBindMountOwnership: vi.fn().mockResolvedValue(undefined),
  bindMountHostSource: vi.fn(),
  numericUid: vi.fn(),
}));

import { swap } from "@/lib/docker/deploy-steps/swap";
import { classifyComposeServices } from "@/lib/docker/deploy-steps/classify-services";
import { parseCompose } from "@/lib/docker/compose-parse";
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { ComposeFile } from "@/lib/docker/compose-types";
import { createStageTimings } from "@/lib/docker/stage-timings";

const calls = () => execFileAsyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));

function compose(): ComposeFile {
  return {
    services: {
      postgres: { name: "postgres", image: "postgres:17", "x-vardo-shared": true },
      frontend: { name: "frontend", build: { context: "." }, labels: { "vardo.traefik": "manual" }, healthcheck: { test: ["CMD", "true"] } },
      worker: {
        name: "worker",
        image: "${COMPOSE_PROJECT_NAME}-frontend",
        pull_policy: "never",
        command: ["worker"],
        stop_grace_period: "10m",
        healthcheck: { test: ["CMD", "curl", "-sf", "http://localhost:3001/healthz"] },
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
    app: { id: "app-1", name: "vardo", healthCheckTimeout: 1, domains: [] },
    envName: "production",
    compose: compose(),
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/vardo/production",
    slotDir: "/opt/vardo/apps/vardo/production/green",
    newProjectName: "vardo-production-green",
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
    timer: createStageTimings(),
    startTime: Date.now(),
  } as unknown as DeployContext;
}

/** The new slot reports `worker` as given; the old slot runs a worker unless `oldWorker` is false. */
function docker(opts: { worker: string; oldWorker?: boolean }) {
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    if (line.includes("-p vardo-production-blue ps -q worker")) return { stdout: opts.oldWorker === false ? "" : "abc\n", stderr: "" };
    if (line.includes("-p vardo-production-green ps --format json")) {
      return {
        stdout: [
          JSON.stringify({ Service: "frontend", Name: "vardo-production-green-frontend-1", State: "running", Health: "healthy" }),
          JSON.stringify({ Service: "worker", Name: "vardo-production-green-worker-1", State: "running", Health: opts.worker }),
        ].join("\n"),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => vi.clearAllMocks());

describe("self-deploy with a worker", () => {
  it("builds the frontend once and never pulls the worker's image", () => {
    const { buildServices, pullServices } = classifyComposeServices(parseCompose(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")).services);
    expect(buildServices).toEqual(["frontend"]);
    expect(pullServices).not.toContain("worker");
  });

  it("starts the new slot's worker with the frontend and passes once both are healthy", async () => {
    docker({ worker: "healthy" });
    const ctx = context();
    await expect(swap(ctx)).resolves.toBeTruthy();
    const up = calls().find((c) => c.includes("-p vardo-production-green up -d"));
    expect(up).toMatch(/up -d --pull never --no-deps frontend worker$/);
  });

  it("fails the deploy while the new worker is unhealthy, before the old slot stops", async () => {
    docker({ worker: "unhealthy" });
    await expect(swap(context())).rejects.toThrow(/worker healthcheck reports unhealthy/);
    expect(calls().some((c) => c.includes("-p vardo-production-blue stop"))).toBe(false);
  });

  it("drains the old worker on its own before the slot-wide stop", async () => {
    docker({ worker: "healthy" });
    const ctx = context();
    await swap(ctx);
    await ctx.stopOldSlot!();
    const stops = calls().filter((c) => c.includes("-p vardo-production-blue stop"));
    expect(stops).toEqual([expect.stringMatching(/stop worker$/), expect.stringMatching(/stop$/)]);
    // The slot-wide stop waits out the worker's grace period.
    const slotStop = execFileAsyncMock.mock.calls.find((c) => (c[1] as string[]).join(" ").endsWith("-p vardo-production-blue stop"));
    expect((slotStop![2] as { timeout: number }).timeout).toBe(615_000);
  });

  it("stops an old slot from before the worker in one step", async () => {
    docker({ worker: "healthy", oldWorker: false });
    const ctx = context();
    await swap(ctx);
    await ctx.stopOldSlot!();
    expect(calls().filter((c) => c.includes("-p vardo-production-blue stop"))).toEqual([expect.stringMatching(/stop$/)]);
  });
});
