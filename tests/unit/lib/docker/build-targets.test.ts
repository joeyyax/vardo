import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { access, readFile, stat } from "fs/promises";
import { join } from "path";

// Build targets: stored config, the SSH session the docker CLI uses, readiness and which failures are the builder's.

const { store, mesh } = vi.hoisted(() => ({ store: new Map<string, string>(), mesh: [] as unknown[] }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async (key: string) => store.get(key) || null,
  setSystemSetting: async (key: string, value: string) => void store.set(key, value),
}));
vi.mock("@/lib/mesh/build-peers", () => ({ meshBuildPeers: async () => mesh }));

const {
  builderFailureReason, BuilderError, configuredTargets, describeTarget, getBuildTargets, isTargetReady, onTarget, openSshSession,
  openTargetSession, remoteEnv, resetTargetHealth, setBuildTargets, targetDockerHost,
} = await import("@/lib/docker/build-targets");

const run = promisify(execFile);

const target = {
  id: "lh", kind: "ssh" as const, name: "Long House", host: "10.99.0.2", port: 2222, user: "vardo",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", hostKey: "[10.99.0.2]:2222 ssh-ed25519 AAAAC3", maxConcurrent: 2,
};

const ACCESS = { host: "10.99.0.2", port: 1234, serverName: "vardo-mesh-builder", ca: "ca", cert: "cert", key: "key" };
const linked = (over: Record<string, unknown> = {}) => ({
  peerId: "lhpeer", name: "Long House", host: "10.99.0.2", port: 1234, builder: ACCESS, waiting: null, accepts: true, ...over,
});

beforeEach(() => {
  store.clear();
  mesh.length = 0;
  resetTargetHealth();
});

describe("stored targets", () => {
  it("round-trips in order and drops entries it can't use", async () => {
    await setBuildTargets([target, { ...target, id: "hz", host: "builder.example.com", port: 22 }]);
    expect((await getBuildTargets()).map((t) => t.id)).toEqual(["lh", "hz"]);
    store.set("build_targets", JSON.stringify({ targets: [target, { ...target, id: "bad", host: "a b\nProxyCommand x" }] }));
    expect((await getBuildTargets()).map((t) => t.id)).toEqual(["lh"]);
  });

  it("is empty when unset", async () => {
    expect(await getBuildTargets()).toEqual([]);
  });
});

describe("linked instances", () => {
  it("join at the end once they accept builds, one at a time, over the mesh", async () => {
    await setBuildTargets([target]);
    mesh.push(linked(), linked({ peerId: "other", name: "Edge", accepts: false, builder: null, waiting: "Edge doesn't accept builds from here" }));
    const targets = await getBuildTargets();
    expect(targets.map((t) => [t.id, t.kind])).toEqual([["lh", "ssh"], ["mesh-lhpeer", "mesh"]]);
    expect(targets[1]).toMatchObject({ host: "10.99.0.2", port: 1234, user: "", privateKey: "", hostKey: null, maxConcurrent: 1, builder: ACCESS });
    expect(describeTarget(targets[1])).toBe("Long House (isolated builder at 10.99.0.2:1234)");
  });

  it("keep their place and limit but never store the link's key or host key", async () => {
    mesh.push(linked());
    const [lh] = await getBuildTargets();
    await setBuildTargets([{ ...lh, maxConcurrent: 3 }, target]);
    const raw = store.get("build_targets")!;
    expect(JSON.parse(raw).targets[0]).toEqual({ id: "mesh-lhpeer", kind: "mesh", peerId: "lhpeer", maxConcurrent: 3 });
    expect(raw).not.toContain("mesh\\n");
    expect((await getBuildTargets()).map((t) => [t.id, t.maxConcurrent])).toEqual([["mesh-lhpeer", 3], ["lh", 2]]);
  });

  it("drop out when unlinked and get no builds until they're ready", async () => {
    mesh.push(linked());
    await setBuildTargets(await getBuildTargets());
    mesh.length = 0;
    expect(await getBuildTargets()).toEqual([]);
    mesh.push(linked({ accepts: true, builder: null, waiting: "Long House hasn't offered its isolated builder yet" }));
    expect((await getBuildTargets())[0]).toMatchObject({ kind: "mesh", builder: null, waiting: expect.stringContaining("isolated builder") });
    expect(await configuredTargets()).toEqual([]);
  });

  it("open no SSH session, and one without a builder fails as the builder's fault", async () => {
    mesh.push(linked(), linked({ peerId: "other", name: "Edge", builder: null, waiting: "Edge hasn't offered its isolated builder yet" }));
    const [lh, edge] = await getBuildTargets();
    expect((await openTargetSession(lh)).env).toEqual({});
    const err = await openTargetSession(edge).catch((e) => e);
    expect(err).toBeInstanceOf(BuilderError);
    expect(err.reason).toBe("Edge hasn't offered its isolated builder yet");
  });
});

describe("DOCKER_HOST", () => {
  it("names user, host and port, bracketing IPv6", () => {
    expect(targetDockerHost(target)).toBe("ssh://vardo@10.99.0.2:2222");
    expect(targetDockerHost({ ...target, host: "fd00::2", port: 22 })).toBe("ssh://vardo@[fd00::2]:22");
    expect(describeTarget(target)).toBe("Long House (vardo@10.99.0.2:2222)");
  });
});

describe("openSshSession", () => {
  it("puts an ssh on PATH that uses the key and the pinned host key, and never prompts", async () => {
    const session = await openSshSession(target);
    try {
      expect(session.env.DOCKER_HOST).toBe("ssh://vardo@10.99.0.2:2222");
      const bin = session.env.PATH.split(":")[0];
      const dir = join(bin, "..");
      expect((await stat(join(dir, "id"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(dir, "known_hosts"), "utf-8")).toBe(`${target.hostKey}\n`);
      const { stdout } = await run(join(bin, "ssh"), ["-G", "-p", "2222", "vardo@10.99.0.2"]);
      expect(stdout).toContain(`identityfile ${join(dir, "id")}`);
      expect(stdout).toContain(`userknownhostsfile ${join(dir, "known_hosts")}`);
      expect(stdout).toContain("stricthostkeychecking true");
      expect(stdout).toContain("batchmode yes");
    } finally {
      await session.close();
    }
  });

  it("refuses a target whose host key isn't pinned", async () => {
    await expect(openSshSession({ ...target, hostKey: null })).rejects.toBeInstanceOf(BuilderError);
  });

  it("leaves nothing behind once closed", async () => {
    const session = await openSshSession(target);
    const dir = join(session.env.PATH.split(":")[0], "..");
    await session.close();
    await expect(access(dir)).rejects.toThrow();
  });
});

describe("remoteEnv", () => {
  it("points at the target and drops this host's builder settings", () => {
    const env = remoteEnv(
      { PATH: "/usr/bin", DOCKER_CONTEXT: "orbstack", BUILDX_BUILDER: "vardo-bounded", BUILDKIT_HOST: "docker-container://vardo-buildkit", DOCKER_CONFIG: "/tmp/auth" } as unknown as NodeJS.ProcessEnv,
      { env: { DOCKER_HOST: "ssh://vardo@h:22", PATH: "/tmp/s/bin:/usr/bin" }, close: async () => {} },
    );
    expect(env).toEqual({ PATH: "/tmp/s/bin:/usr/bin", DOCKER_HOST: "ssh://vardo@h:22", DOCKER_CONFIG: "/tmp/auth" });
  });
});

describe("builderFailureReason", () => {
  it.each([
    ["ssh: connect to host 10.99.0.2 port 22: Connection refused", "it's unreachable"],
    ["error during connect: Get \"http://docker.example.com/v1.47/version\": command [ssh ...] has exited with exit status 255", "the connection to it dropped"],
    ["Host key verification failed.", "its SSH host key doesn't match the pinned one"],
    ["vardo@10.99.0.2: Permission denied (publickey).", "SSH refused the key"],
    ["failed to copy: write /var/lib/docker/tmp/x: no space left on device", "it's out of disk"],
    ["ssh: Could not resolve hostname builder: Name or service not known", "its hostname doesn't resolve"],
  ])("blames the builder for %s", (message, reason) => {
    expect(builderFailureReason(message)).toBe(reason);
  });

  it("leaves the app's own build errors alone", () => {
    expect(builderFailureReason('failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1')).toBeNull();
    expect(builderFailureReason("failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory")).toBeNull();
  });
});

describe("onTarget", () => {
  const session = { env: { DOCKER_HOST: "ssh://x@y:22", PATH: "/bin" }, close: vi.fn(async () => {}) };

  it("turns a builder failure into a BuilderError and closes the session", async () => {
    const err = Object.assign(new Error("docker failed (exit 1)"), { stderr: "ssh: connect to host y port 22: Connection timed out" });
    await expect(onTarget(target, async () => Promise.reject(err), async () => session)).rejects.toMatchObject({
      name: "BuilderError",
      reason: "it's unreachable",
    });
    expect(session.close).toHaveBeenCalled();
  });

  it("passes the app's errors through", async () => {
    const err = new Error("docker failed (exit 1): exit code: 2");
    await expect(onTarget(target, async () => Promise.reject(err), async () => session)).rejects.toBe(err);
  });
});

describe("isTargetReady", () => {
  it("is false without a pinned host key or any slots, without checking", async () => {
    const check = vi.fn(async () => {});
    expect(await isTargetReady({ ...target, hostKey: null }, check)).toBe(false);
    expect(await isTargetReady({ ...target, maxConcurrent: 0 }, check)).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks once and caches the answer", async () => {
    const check = vi.fn(async () => {});
    expect(await isTargetReady(target, check)).toBe(true);
    expect(await isTargetReady(target, check)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("is false for a target that doesn't answer", async () => {
    expect(await isTargetReady(target, async () => Promise.reject(new Error("timeout")))).toBe(false);
  });
});

describe("a linked instance's isolated builder", () => {
  const BUILDER = { host: "10.99.0.2", port: 1234, serverName: "vardo-mesh-builder", ca: "ca", cert: "cert", key: "key" };

  it("joins the targets without an SSH host key and is named by its builder", async () => {
    mesh.push(linked({ hostKey: null, privateKey: "", builder: BUILDER }));
    const [t] = await configuredTargets();
    expect(t).toMatchObject({ kind: "mesh", hostKey: null, builder: BUILDER });
    expect(describeTarget(t)).toBe("Long House (isolated builder at 10.99.0.2:1234)");
  });

  it("runs without opening SSH, so the docker CLI stays pointed here", async () => {
    mesh.push(linked({ hostKey: null, privateKey: "", builder: BUILDER }));
    const [t] = await configuredTargets();
    const env = await onTarget(t, async (session) => remoteEnv({ DOCKER_HOST: "unix:///var/run/docker.sock", BUILDX_BUILDER: "x" } as unknown as NodeJS.ProcessEnv, session));
    expect(env).toEqual({ DOCKER_HOST: "unix:///var/run/docker.sock" });
  });

  it("is ready when its builder answers", async () => {
    mesh.push(linked({ hostKey: null, privateKey: "", builder: BUILDER }));
    const [t] = await configuredTargets();
    const check = vi.fn().mockResolvedValue("buildkit");
    expect(await isTargetReady(t, check)).toBe(true);
    expect(check).toHaveBeenCalledWith(t);
  });

  it("calls a refused certificate the builder's fault", () => {
    expect(builderFailureReason("remote error: tls: certificate required")).toBe("its builder refused this instance's certificate");
  });
});
