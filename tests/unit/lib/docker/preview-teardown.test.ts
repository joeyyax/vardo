import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// A preview teardown must only ever reach the preview's own compose projects.
// Closing PR #25 once took down every `notes-api-production-*` container.

const { projectsDir, execFileMock, updateMock, deleteMock, findGroupEnv } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require("path") as typeof import("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: t } = require("os") as typeof import("os");
  const dir = mk(j(t(), "vardo-teardown-"));
  process.env.VARDO_PROJECTS_DIR = dir;
  const where = vi.fn().mockResolvedValue(undefined);
  return {
    projectsDir: dir,
    execFileMock: vi.fn(),
    updateMock: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
    deleteMock: vi.fn(() => ({ where })),
    findGroupEnv: vi.fn(),
  };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileMock,
    configurable: true,
    writable: true,
  });
  return { ...actual, execFile };
});
vi.mock("@/lib/db", () => ({
  db: {
    update: updateMock,
    delete: deleteMock,
    query: {
      groupEnvironments: { findFirst: findGroupEnv },
      environments: { findFirst: vi.fn().mockResolvedValue({ name: "production", isDefault: true }) },
    },
  },
}));
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(),
  resolveCompose: vi.fn(),
  build: vi.fn(),
  swap: vi.fn(),
  postDeploy: vi.fn(),
}));
vi.mock("@/lib/docker/app-dir-owner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/app-dir-owner")>(
    "@/lib/docker/app-dir-owner",
  );
  return { ...actual, assertAppDirOwnership: vi.fn().mockResolvedValue(undefined) };
});

import { destroyGroupEnvironment } from "@/lib/docker/clone";

const APP = "notes-api";

function seedSlot(env: string, slot: string) {
  const dir = join(projectsDir, APP, env, slot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "docker-compose.yml"),
    "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n    x-vardo-shared: true\n",
  );
}

function composeProjects(): string[] {
  return execFileMock.mock.calls
    .filter(([cmd, args]) => cmd === "docker" && (args as string[])[0] === "compose")
    .map(([, args]) => {
      const a = args as string[];
      return a[a.indexOf("-p") + 1];
    });
}

function downProjects(): string[] {
  return execFileMock.mock.calls
    .filter(([cmd, args]) => cmd === "docker" && (args as string[]).includes("down"))
    .map(([, args]) => {
      const a = args as string[];
      return a[a.indexOf("-p") + 1];
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(join(projectsDir, APP), { recursive: true, force: true });
  seedSlot("production", "blue");
  seedSlot("pr-25", "blue");
  execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
  findGroupEnv.mockResolvedValue({
    id: "ge-1",
    name: "pr-25",
    type: "preview",
    project: { organizationId: "org-1" },
    environments: [
      {
        id: "env-pr",
        appId: "app-1",
        name: "pr-25",
        domain: "notes-api-pr-25.example.com",
        app: { id: "app-1", name: APP },
      },
    ],
  });
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("destroyGroupEnvironment", () => {
  it("never runs compose against production", async () => {
    await destroyGroupEnvironment("ge-1", "org-1");

    const projects = composeProjects();
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) expect(p).toMatch(/-pr-25-/);
  });

  it("downs the preview's slot and shared projects", async () => {
    await destroyGroupEnvironment("ge-1", "org-1");

    expect(downProjects()).toEqual(
      expect.arrayContaining([`${APP}-pr-25-blue`, `${APP}-pr-25-shared`]),
    );
  });

  it("leaves the production app's status alone", async () => {
    await destroyGroupEnvironment("ge-1", "org-1");

    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps the rows when a compose down fails", async () => {
    execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("down")) throw new Error("daemon unreachable");
      return { stdout: "", stderr: "" };
    });

    await expect(destroyGroupEnvironment("ge-1", "org-1")).rejects.toThrow();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes the rows once the stop succeeds", async () => {
    await destroyGroupEnvironment("ge-1", "org-1");

    expect(deleteMock).toHaveBeenCalled();
  });
});
