// #892: deleting an app removes its stopped containers and their networks, and takes over a foreign app dir.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { dockerRequestMock, removeContainerMock, execMock, lstatMock } = vi.hoisted(() => ({
  dockerRequestMock: vi.fn(),
  removeContainerMock: vi.fn(),
  execMock: vi.fn(),
  lstatMock: vi.fn(),
}));

vi.mock("@/lib/docker/client", () => ({
  dockerRequest: dockerRequestMock,
  removeContainer: removeContainerMock,
}));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execMock }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("fs/promises", async (orig) => ({ ...(await orig<typeof import("fs/promises")>()), lstat: lstatMock }));

import { claimAppDirTopLevel, removeAppContainersAndNetworks } from "@/lib/docker/delete-teardown";
import { PROJECTS_DIR } from "@/lib/paths";

const STOPPED = {
  Id: "c-stopped",
  Names: ["/agents-production-blue-web-1"],
  State: "exited",
  Labels: { "vardo.project.id": "app-1", "com.docker.compose.project": "agents-production-blue" },
};

beforeEach(() => {
  vi.resetAllMocks();
  removeContainerMock.mockResolvedValue(undefined);
});

describe("removeAppContainersAndNetworks", () => {
  it("removes a stopped container labeled with the app id", async () => {
    dockerRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path.startsWith("/containers/json")) {
        const filters = JSON.parse(decodeURIComponent(path.split("filters=")[1]));
        expect(path).toContain("all=true");
        return filters.label.includes("vardo.project.id=app-1") ? [STOPPED] : [];
      }
      return [];
    });

    const result = await removeAppContainersAndNetworks(["app-1"]);

    expect(removeContainerMock).toHaveBeenCalledWith("c-stopped", { force: true });
    expect(result.containers).toEqual(["agents-production-blue-web-1"]);
  });

  it("removes the networks of the compose projects those containers ran in", async () => {
    dockerRequestMock.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/containers/json")) return [STOPPED];
      if (path.startsWith("/networks?")) {
        const filters = JSON.parse(decodeURIComponent(path.split("filters=")[1]));
        expect(filters.label).toEqual(["com.docker.compose.project=agents-production-blue"]);
        return [{ Id: "n1", Name: "agents-production-blue_internal" }];
      }
      return undefined;
    });

    const result = await removeAppContainersAndNetworks(["app-1"]);

    expect(dockerRequestMock).toHaveBeenCalledWith("DELETE", "/networks/n1");
    expect(result.networks).toEqual(["agents-production-blue_internal"]);
  });

  it("lists nothing it was not asked for and removes nothing when no container carries the label", async () => {
    dockerRequestMock.mockResolvedValue([]);

    const result = await removeAppContainersAndNetworks(["app-1"]);

    expect(removeContainerMock).not.toHaveBeenCalled();
    expect(result.networks).toEqual([]);
    expect(dockerRequestMock).not.toHaveBeenCalledWith("DELETE", expect.anything());
  });

  it("keeps going and reports when a container or network won't go", async () => {
    removeContainerMock.mockRejectedValue(new Error("409 busy"));
    dockerRequestMock.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/containers/json")) return [STOPPED];
      if (path.startsWith("/networks?")) return [{ Id: "n1", Name: "net" }];
      throw new Error("403 in use");
    });

    const result = await removeAppContainersAndNetworks(["app-1"]);

    expect(result.containers).toEqual([]);
    expect(result.log.join("\n")).toContain("Kept container");
    expect(result.log.join("\n")).toContain("Kept network net");
  });
});

describe("claimAppDirTopLevel", () => {
  it("chowns the top level only, through a throwaway container", async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => true });
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const dir = `${PROJECTS_DIR}/agents`;

    await expect(claimAppDirTopLevel(dir)).resolves.toBe(true);

    const [cmd, args] = execMock.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain(`${dir}:/target`);
    expect(args).toContain("chown");
    expect(args).not.toContain("-R");
  });

  it("refuses a path outside the apps directory", async () => {
    await expect(claimAppDirTopLevel("/etc")).resolves.toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("refuses a symlink", async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => false });

    await expect(claimAppDirTopLevel(`${PROJECTS_DIR}/agents`)).resolves.toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });
});
