// A target's builder: a linked instance's vardo-buildkit under a session-private buildx config, else its daemon.

import { describe, it, expect, beforeEach } from "vitest";
import { access } from "fs/promises";
import { TARGET_BUILDER, targetBuilder, withTargetBuilder } from "@/lib/docker/target-builder";
import { TARGET_BUILD } from "@/lib/docker/remote-build";

const there = { DOCKER_HOST: "ssh://vardo-mesh@10.99.0.2:2222" } as unknown as NodeJS.ProcessEnv & { DOCKER_HOST: string };
const GiB = 1024 ** 3;
const CONTAINERD = `overlayfs|[["driver-type","io.containerd.snapshotter.v1"]]`;

type Call = { args: string[]; env: NodeJS.ProcessEnv };

function fakeDocker(opts: { inspect?: string | Error; create?: Error; info?: string } = {}) {
  const calls: Call[] = [];
  const exec = async (_cmd: string, args: string[], o: Record<string, unknown>) => {
    calls.push({ args, env: o.env as NodeJS.ProcessEnv });
    if (args[0] === "inspect") {
      if (opts.inspect instanceof Error) throw opts.inspect;
      return { stdout: opts.inspect ?? `true ${6 * GiB}\n` };
    }
    if (args[0] === "buildx") {
      if (opts.create) throw opts.create;
      return { stdout: "" };
    }
    if (args[0] === "info") return { stdout: opts.info ?? CONTAINERD };
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { calls, exec };
}

const exists = (path: string) => access(path).then(() => true, () => false);

describe("targetBuilder", () => {
  let lines: string[];
  const log = (line: string) => void lines.push(line);

  beforeEach(() => {
    lines = [];
  });

  it("builds on a plain SSH target's daemon without asking it anything", async () => {
    const docker = fakeDocker();
    const { build } = await targetBuilder({ kind: "ssh", name: "builder" }, there, log, { exec: docker.exec });
    expect(build).toBe(TARGET_BUILD);
    expect(docker.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("builds in a linked instance's vardo-buildkit, exporting for its image store, and names the limit", async () => {
    const docker = fakeDocker();
    const { build, close } = await targetBuilder({ kind: "mesh", name: "Long House" }, there, log, { exec: docker.exec });
    const dir = build.env.BUILDX_CONFIG;
    expect(build.env).toEqual({ BUILDX_CONFIG: expect.stringContaining("vardo-buildx-"), BUILDX_BUILDER: TARGET_BUILDER });
    expect(build.loadArgs).toEqual(["--output", "type=docker,compression=zstd", "--provenance=false", "--sbom=false"]);
    expect(build.limitBytes).toBe(6 * GiB);
    expect(lines).toEqual(["[build] Building in Long House's vardo-buildkit (memory limit 6 GiB)"]);

    const create = docker.calls.find((c) => c.args[0] === "buildx")!;
    expect(create.args).toEqual(["buildx", "create", "--name", TARGET_BUILDER, "--driver", "remote", "--bootstrap", "docker-container://vardo-buildkit"]);
    expect(create.env).toMatchObject({ ...there, BUILDX_CONFIG: dir });
    expect(docker.calls.every((c) => c.env.DOCKER_HOST === there.DOCKER_HOST)).toBe(true);

    expect(await exists(dir)).toBe(true);
    await close();
    expect(await exists(dir)).toBe(false);
  });

  it("exports uncompressed for a classic image store", async () => {
    const docker = fakeDocker({ info: "overlay2|[]" });
    const { build, close } = await targetBuilder({ kind: "mesh", name: "Long House" }, there, log, { exec: docker.exec });
    expect(build.output).toBe("type=docker,compression=uncompressed");
    await close();
  });

  it("falls back to the daemon with one line when the peer has no running vardo-buildkit", async () => {
    for (const inspect of ["false 0", new Error("No such object: vardo-buildkit")]) {
      lines = [];
      const docker = fakeDocker({ inspect });
      const { build } = await targetBuilder({ kind: "mesh", name: "Long House" }, there, log, { exec: docker.exec });
      expect(build).toBe(TARGET_BUILD);
      expect(lines).toEqual(["[build] Long House has no running vardo-buildkit, so this build runs on its Docker daemon with no memory limit"]);
      expect(docker.calls.some((c) => c.args[0] === "buildx")).toBe(false);
    }
  });

  it("falls back to the daemon and removes the config when registering the builder fails", async () => {
    const docker = fakeDocker({ create: Object.assign(new Error("exit 1"), { stderr: "ERROR: failed to dial\nmore" }) });
    const { build } = await targetBuilder({ kind: "mesh", name: "Long House" }, there, log, { exec: docker.exec });
    expect(build).toBe(TARGET_BUILD);
    expect(lines).toEqual(["[build] Couldn't reach Long House's vardo-buildkit (ERROR: failed to dial), so this build runs on its Docker daemon with no memory limit"]);
    const dir = docker.calls.find((c) => c.args[0] === "buildx")!.env.BUILDX_CONFIG!;
    expect(await exists(dir)).toBe(false);
  });
});

describe("withTargetBuilder", () => {
  it("removes the builder config after the build, even when it fails", async () => {
    const docker = fakeDocker();
    let dir = "";
    await expect(
      withTargetBuilder({ kind: "mesh", name: "Long House" }, there, () => {}, async (build) => {
        dir = build.env.BUILDX_CONFIG;
        expect(await exists(dir)).toBe(true);
        throw new Error("failed to solve");
      }, { exec: docker.exec }),
    ).rejects.toThrow("failed to solve");
    expect(await exists(dir)).toBe(false);
  });
});
