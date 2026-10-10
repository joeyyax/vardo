// Bind sources outside the allowed roots keep deploying when the running slot already mounts them.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsyncMock, rmMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn(), rmMock: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execFileAsyncMock }));
vi.mock("fs/promises", async (original) => ({ ...(await original<typeof import("fs/promises")>()), rm: rmMock }));
vi.mock("@/lib/docker/slot-files", async (original) => ({
  ...(await original<typeof import("@/lib/docker/slot-files")>()),
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
}));
vi.mock("@/lib/docker/bind-roots", async (original) => ({
  ...(await original<typeof import("@/lib/docker/bind-roots")>()),
  bindRoots: vi.fn().mockResolvedValue(["/mnt"]),
}));

import { assertComposeWithinApp } from "@/lib/docker/compose-policy";
import { DeployBlockedError } from "@/lib/docker/errors";

const APP_DIR = "/opt/vardo/apps/blog/production";

const withBinds = (...sources: string[]) => ({
  stdout: JSON.stringify({
    services: { web: { image: "nginx", volumes: sources.map((source) => ({ type: "bind", source, target: `/h${source}` })) } },
  }),
  stderr: "",
});

/** Configs by slot directory: the new slot and the running one. */
function slots(next: string[], running: string[]) {
  execFileAsyncMock.mockImplementation(async (_cmd: string, _args: string[], opts: { cwd: string }) =>
    withBinds(...(opts.cwd.endsWith("/green") ? next : running)),
  );
}

const deploy = (reuse?: "start") =>
  assertComposeWithinApp({
    slotDir: `${APP_DIR}/green`,
    appDir: APP_DIR,
    repoDir: null,
    newProjectName: "blog-production-green",
    stableVolumePrefix: "blog-production",
    composeFileArgs: ["-f", "docker-compose.yml"],
    orgTrusted: false,
    projectAllowBindMounts: true,
    projectAllowDockerSocket: false,
    previousSlotDir: `${APP_DIR}/blue`,
    reuse,
  });

beforeEach(() => {
  vi.clearAllMocks();
  rmMock.mockResolvedValue(undefined);
});

describe("assertComposeWithinApp — bind roots", () => {
  it("keeps a path the running slot mounts and reports it", async () => {
    slots(["/home/user/media", "/mnt/data"], ["/home/user/media"]);
    await expect(deploy()).resolves.toEqual({ legacyPaths: ["/home/user/media"] });
  });

  it("refuses a new path outside the roots", async () => {
    slots(["/home/user/.ssh"], ["/home/user/media"]);
    const err = await deploy().catch((e) => e);
    expect(err).toBeInstanceOf(DeployBlockedError);
    expect(err.message).toContain("outside the allowed host roots");
  });

  it("keeps the running slot's own paths on a restart", async () => {
    execFileAsyncMock.mockResolvedValue(withBinds("/usr/share/data"));
    await expect(deploy("start")).resolves.toEqual({ legacyPaths: ["/usr/share/data"] });
  });
});
