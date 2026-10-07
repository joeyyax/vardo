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

import { destroyGroupEnvironment, previewGroupStrays } from "@/lib/docker/clone";
import { foreignPreviewContainers } from "@/lib/docker/deploy";

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
    prNumber: 25,
    project: { organizationId: "org-1" },
    environments: [
      {
        id: "env-pr",
        appId: "app-1",
        name: "pr-25",
        type: "preview",
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

describe("destroyGroupEnvironment on something that isn't a preview", () => {
  const groupWith = (env: Record<string, unknown>) => ({
    id: "ge-1",
    name: "pr-25",
    type: "preview",
    prNumber: 25,
    project: { organizationId: "org-1" },
    environments: [{ appId: "app-1", app: { id: "app-1", name: APP }, ...env }],
  });

  it("refuses a preview group holding the production environment", async () => {
    findGroupEnv.mockResolvedValue(groupWith({ name: "production", type: "production", isDefault: true }));

    await expect(destroyGroupEnvironment("ge-1", "org-1")).rejects.toThrow(/not a preview/);
    expect(composeProjects()).toEqual([]);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("stops a staging group named pr-25 without touching production", async () => {
    findGroupEnv.mockResolvedValue({ ...groupWith({ name: "pr-25", type: "preview" }), type: "staging" });

    await expect(destroyGroupEnvironment("ge-1", "org-1")).resolves.toBeDefined();
    for (const p of composeProjects()) expect(p).not.toMatch(/production/);
  });

  it("won't down a compose project holding containers labelled for another environment", async () => {
    execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") return { stdout: "notes-api-production-web-1\tapp-1\tproduction\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    await expect(destroyGroupEnvironment("ge-1", "org-1")).rejects.toThrow(/not labelled as this preview/);
    expect(downProjects()).toEqual([]);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("keeps a production hostname stored on the preview environment", async () => {
    findGroupEnv.mockResolvedValue(groupWith({ name: "pr-25", type: "preview", domain: "knowledge.example.com" }));

    await destroyGroupEnvironment("ge-1", "org-1");

    // Only the group row goes, never a domain row.
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});

describe("previewGroupStrays", () => {
  const env = { name: "pr-25", type: "preview", isDefault: false };

  it("accepts a PR's own preview", () => {
    expect(previewGroupStrays({ name: "pr-25", type: "preview", prNumber: 25, environments: [env] })).toEqual([]);
  });

  it.each([
    ["staging group", { name: "pr-25", type: "staging", prNumber: 25, environments: [env] }],
    ["unnamed group", { name: "qa", type: "preview", prNumber: 25, environments: [env] }],
    ["mismatched PR", { name: "pr-25", type: "preview", prNumber: 26, environments: [env] }],
    ["default env", { name: "pr-25", type: "preview", prNumber: 25, environments: [{ ...env, isDefault: true }] }],
    ["other env name", { name: "pr-25", type: "preview", prNumber: 25, environments: [{ ...env, name: "production" }] }],
    ["non-preview env", { name: "pr-25", type: "preview", prNumber: 25, environments: [{ ...env, type: "staging" }] }],
  ])("flags a %s", (_label, group) => {
    expect(previewGroupStrays(group)).not.toEqual([]);
  });
});

describe("foreignPreviewContainers", () => {
  it("passes containers labelled with this app and environment", () => {
    expect(foreignPreviewContainers("a-pr-25-web-1\tapp-1\tpr-25\n", "app-1", "pr-25")).toEqual([]);
  });

  it("flags another app, another environment and unlabelled containers", () => {
    const ps = ["x-1\tapp-2\tpr-25", "y-1\tapp-1\tproduction", "z-1\t\t"].join("\n");
    expect(foreignPreviewContainers(ps, "app-1", "pr-25")).toEqual(["x-1", "y-1", "z-1"]);
  });
});
