// Start, restart and recreate re-run the slot's files, so an untrusted app's pre-#886 slot is checked first (#895).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsyncMock, orgFindFirst, appFindFirst, rmMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  orgFindFirst: vi.fn(),
  appFindFirst: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execFileAsyncMock }));
vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  access: vi.fn().mockResolvedValue(undefined),
  rm: rmMock,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appFindFirst },
      organizations: { findFirst: orgFindFirst },
      projects: { findFirst: vi.fn().mockResolvedValue({ allowBindMounts: false, allowDockerSocket: false }) },
      environments: { findFirst: vi.fn().mockResolvedValue({ type: "production" }) },
    },
  },
}));
vi.mock("@/lib/docker/compose", () => ({ slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]) }));

import { assertSlotWithinApp } from "@/lib/docker/slot-guard";
import { DeployBlockedError } from "@/lib/docker/errors";

const slot = (reuse: "start" | "restart" | "recreate") =>
  assertSlotWithinApp({
    appName: "blog",
    envName: "production",
    slotDir: "/data/projects/blog/production/blue",
    composeProject: "blog-production-blue",
    reuse,
  });

const configWith = (source: string) => ({
  stdout: JSON.stringify({
    services: { web: { image: "nginx", volumes: [{ type: "bind", source, target: "/host" }] } },
  }),
  stderr: "",
});

beforeEach(() => {
  vi.clearAllMocks();
  appFindFirst.mockResolvedValue({ id: "a1", organizationId: "o1", projectId: "p1" });
  orgFindFirst.mockResolvedValue({ trusted: false });
});

describe("assertSlotWithinApp", () => {
  it.each(["start", "restart", "recreate"] as const)(
    "refuses an untrusted slot holding a forbidden mount on %s and keeps its files",
    async (reuse) => {
      execFileAsyncMock.mockResolvedValue(configWith("/etc"));

      const err = await slot(reuse).catch((e) => e);

      expect(err).toBeInstanceOf(DeployBlockedError);
      expect(err.message).toContain(`Couldn't ${reuse}`);
      expect(err.message).toContain("Redeploy");
      expect(rmMock).not.toHaveBeenCalled();
    },
  );

  it("passes an untrusted slot that stays inside the app", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ services: { web: { image: "nginx" } } }),
      stderr: "",
    });

    await expect(slot("restart")).resolves.toBeUndefined();
  });

  it("doesn't resolve a trusted org's compose", async () => {
    orgFindFirst.mockResolvedValue({ trusted: true });

    await expect(slot("restart")).resolves.toBeUndefined();
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("treats an app with no row as untrusted", async () => {
    appFindFirst.mockResolvedValue(undefined);
    execFileAsyncMock.mockResolvedValue(configWith("/etc"));

    await expect(slot("start")).rejects.toThrow(DeployBlockedError);
  });
});
