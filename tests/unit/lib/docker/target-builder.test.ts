// A target's builder: a linked instance's isolated builder over TLS, else the target's daemon.

import { describe, it, expect, beforeEach } from "vitest";
import { access, readFile } from "fs/promises";
import { BuilderError } from "@/lib/docker/build-targets";
import { TARGET_BUILDER, targetBuilder, withTargetBuilder } from "@/lib/docker/target-builder";
import { TARGET_BUILD } from "@/lib/docker/remote-build";
import { meshBuilderStats } from "@/lib/docker/mesh-builder";

const there = { DOCKER_HOST: "ssh://vardo-mesh@10.99.0.2:2222" } as unknown as NodeJS.ProcessEnv & { DOCKER_HOST: string };

type Call = { args: string[]; env: NodeJS.ProcessEnv };

function fakeDocker(opts: { create?: Error } = {}) {
  const calls: Call[] = [];
  const exec = async (_cmd: string, args: string[], o: Record<string, unknown>) => {
    calls.push({ args, env: o.env as NodeJS.ProcessEnv });
    if (args[0] === "buildx") {
      if (opts.create) throw opts.create;
      return { stdout: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { calls, exec };
}

const exists = (path: string) => access(path).then(() => true, () => false);

const here = {} as NodeJS.ProcessEnv;
const ACCESS = {
  host: "10.99.0.2", port: 1234, serverName: "vardo-mesh-builder",
  ca: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
  cert: "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n",
  key: "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n",
};

describe("targetBuilder", () => {
  let lines: string[];
  const log = (line: string) => void lines.push(line);

  beforeEach(() => {
    lines = [];
  });

  it("builds on a plain SSH target's daemon without asking it anything", async () => {
    const docker = fakeDocker();
    const { build, compression } = await targetBuilder({ kind: "ssh", name: "builder" }, there, log, { exec: docker.exec });
    expect(build).toBe(TARGET_BUILD);
    expect(compression).toBeNull();
    expect(docker.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("refuses a linked instance without an isolated builder, and never reaches its daemon", async () => {
    const docker = fakeDocker();
    const err = await targetBuilder({ kind: "mesh", name: "Long House" }, there, log, { exec: docker.exec }).catch((e) => e);
    expect(err).toBeInstanceOf(BuilderError);
    expect(err.reason).toBe("Long House has no isolated builder for this instance");
    expect(docker.calls).toEqual([]);
  });
});

describe("targetBuilder with a peer's isolated builder", () => {
  let lines: string[];
  const log = (line: string) => void lines.push(line);
  const local = async () => "containerd" as const;

  beforeEach(() => {
    lines = [];
  });

  it("builds over tcp+TLS with the peer's certificate and never touches its daemon", async () => {
    const docker = fakeDocker();
    const { build, close, compression, channel } = await targetBuilder({ kind: "mesh", name: "Long House", builder: ACCESS }, here, log, { exec: docker.exec, localStore: local });
    expect(channel).toBe("session");
    expect(compression).toBe("zstd");
    expect(build.output).toBe("type=docker,compression=zstd");
    expect(build.env.BUILDX_BUILDER).toBe(TARGET_BUILDER);
    expect(docker.calls.map((c) => c.args[0])).toEqual(["buildx"]);
    const [create] = docker.calls;
    const dir = build.env.BUILDX_CONFIG;
    expect(create.args).toEqual([
      "buildx", "create", "--name", TARGET_BUILDER, "--driver", "remote",
      "--driver-opt", `cacert=${dir}/tls/ca.pem,cert=${dir}/tls/cert.pem,key=${dir}/tls/key.pem,servername=vardo-mesh-builder`,
      "--bootstrap", "tcp://10.99.0.2:1234",
    ]);
    expect(await readFile(`${dir}/tls/cert.pem`, "utf8")).toBe(ACCESS.cert);
    expect(lines).toEqual(["[build] Building in Long House's isolated builder over the mesh"]);
    await close();
    expect(await exists(dir)).toBe(false);
  });

  it("pushes gzip when this host's image store is classic", async () => {
    const docker = fakeDocker();
    const { compression, close } = await targetBuilder({ kind: "mesh", name: "Long House", builder: ACCESS }, here, log, { exec: docker.exec, localStore: async () => "classic" });
    expect(compression).toBe("gzip");
    await close();
  });

  it("fails as the builder's fault, without falling back to SSH, when the builder refuses", async () => {
    const docker = fakeDocker({ create: Object.assign(new Error("exit 1"), { stderr: "ERROR: context deadline exceeded" }) });
    const err = await targetBuilder({ kind: "mesh", name: "Long House", builder: ACCESS }, here, log, { exec: docker.exec, localStore: local }).catch((e) => e);
    expect(err).toBeInstanceOf(BuilderError);
    expect(err.reason).toBe("couldn't reach Long House's isolated builder: ERROR: context deadline exceeded");
    expect(docker.calls.map((c) => c.args[0])).toEqual(["buildx"]);
  });
});

describe("withTargetBuilder", () => {
  it("removes the builder config after the build, even when it fails", async () => {
    const docker = fakeDocker();
    let dir = "";
    await expect(
      withTargetBuilder({ kind: "mesh", name: "Long House", builder: ACCESS }, here, () => {}, async ({ build }) => {
        dir = build.env.BUILDX_CONFIG;
        expect(await exists(dir)).toBe(true);
        throw new Error("failed to solve");
      }, { exec: docker.exec, localStore: async () => "containerd" }),
    ).rejects.toThrow("failed to solve");
    expect(await exists(dir)).toBe(false);
  });
});

describe("meshBuilderStats", () => {
  it("reads the isolated builder's OOM kills from its cgroup and its memory limit", async () => {
    const seen: string[] = [];
    const stats = await meshBuilderStats({
      inspect: async () => ({ Id: "abc123", HostConfig: { Memory: 12 * 1024 ** 3 } }),
      oomKills: async (id) => (seen.push(id), 3),
    });
    expect(stats).toEqual({ oomKills: 3, limitBytes: 12 * 1024 ** 3 });
    expect(seen).toEqual(["abc123"]);
  });

  it("has nulls when the builder isn't there or has no limit", async () => {
    expect(await meshBuilderStats({ inspect: async () => { throw new Error("No such container"); }, oomKills: async () => 1 }))
      .toEqual({ oomKills: null, limitBytes: null });
    expect(await meshBuilderStats({ inspect: async () => ({ Id: "abc123", HostConfig: { Memory: 0 } }), oomKills: async () => null }))
      .toEqual({ oomKills: null, limitBytes: null });
  });
});
