import { describe, it, expect, beforeEach } from "vitest";
import { spawn } from "child_process";
import { bringBack, copyImage, resetPushCeilings, MIN_CEILING_BYTES } from "@/lib/docker/remote-build";
import { BuilderError } from "@/lib/docker/build-targets";
import { createBuildPlacement } from "@/lib/docker/build-placement";

// Bringing a target's image here: the build registry first, then `docker save | docker load` over SSH.

const session = { env: { DOCKER_HOST: "ssh://vardo@lh:22", PATH: "/tmp/s/bin:/usr/bin" }, close: async () => {} };

/** Records docker calls other than `history`, which answers with `layers`. */
function recorder(fail?: (args: string[]) => boolean, opts: { layers?: number[]; stderr?: string } = {}) {
  const calls: { args: string[]; where: string }[] = [];
  const exec = async (_cmd: string, args: string[], o: Record<string, unknown>) => {
    if (args[0] === "history") return { stdout: (opts.layers ?? []).join("\n") };
    const env = o.env as NodeJS.ProcessEnv;
    calls.push({ args, where: env.DOCKER_HOST ? "there" : "here" });
    if (fail?.(args)) throw Object.assign(new Error("failed"), { stderr: opts.stderr ?? "unauthorized: authentication required" });
    return { stdout: "" };
  };
  return { calls, exec };
}

/** A spawn that runs a shell script per docker subcommand and records where each ran. */
function shells(scripts: { save: string; load: string }) {
  const ran: string[] = [];
  const fake = ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: ("ignore" | "pipe")[]; detached: boolean }) => {
    const which = args[0] === "save" ? "save" : "load";
    ran.push(`${opts.env.DOCKER_HOST ? "there" : "here"} ${args.join(" ")}`);
    return spawn("sh", ["-c", scripts[which]], { stdio: opts.stdio, detached: opts.detached });
  }) as Parameters<typeof copyImage>[1]["spawn"];
  return { ran, spawn: fake };
}

const env = { here: {} as NodeJS.ProcessEnv, there: { DOCKER_HOST: "ssh://vardo@lh:22" } as unknown as NodeJS.ProcessEnv };

describe("copyImage", () => {
  it("pipes save there into load here and counts the bytes", async () => {
    const { ran, spawn } = shells({ save: "head -c 300000 /dev/zero", load: "test \"$(wc -c)\" -eq 300000" });
    expect(await copyImage("shop:d", { fromEnv: env.there, toEnv: env.here, spawn })).toBe(300_000);
    expect(ran).toEqual(["there save shop:d", "here load --quiet"]);
  });

  it("kills load when save fails, with save's error", async () => {
    const { spawn } = shells({ save: "echo 'error during connect: ssh: connect to host lh port 22: Connection refused' >&2; exit 1", load: "sleep 30" });
    const began = Date.now();
    await expect(copyImage("shop:d", { fromEnv: env.there, toEnv: env.here, spawn }))
      .rejects.toThrow(/^docker save on the target failed \(exit 1\): error during connect/);
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("kills save when load fails, with load's error", async () => {
    const { spawn } = shells({ save: "while true; do head -c 65536 /dev/zero; done", load: "head -c 1000 >/dev/null; echo 'write /var/lib/docker: no space left on device' >&2; exit 1" });
    const began = Date.now();
    await expect(copyImage("shop:d", { fromEnv: env.there, toEnv: env.here, spawn }))
      .rejects.toThrow(/^docker load here failed \(exit 1\): write \/var\/lib\/docker: no space left on device$/);
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("kills both when the deploy is aborted", async () => {
    const { spawn } = shells({ save: "sleep 30", load: "sleep 30" });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const began = Date.now();
    await expect(copyImage("shop:d", { fromEnv: env.there, toEnv: env.here, spawn, signal: abort.signal })).rejects.toThrow("Deployment aborted");
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("fails a copy that stops sending", async () => {
    const { spawn } = shells({ save: "head -c 10 /dev/zero; sleep 30", load: "cat >/dev/null" });
    await expect(copyImage("shop:d", { fromEnv: env.there, toEnv: env.here, spawn, idleMs: 200 })).rejects.toThrow("no data for 0.2s");
  });

  it("fails when docker can't start", async () => {
    const fake = ((_c: string, _a: string[], opts: { stdio: ("ignore" | "pipe")[] }) =>
      spawn("/nonexistent/docker", [], { stdio: opts.stdio })) as Parameters<typeof copyImage>[1]["spawn"];
    await expect(copyImage("shop:d", { fromEnv: env.there, toEnv: env.here, spawn: fake })).rejects.toThrow(/couldn't start: spawn \/nonexistent\/docker ENOENT/);
  });
});

describe("bringBack", () => {
  const authEnv = { DOCKER_CONFIG: "/tmp/auth" } as unknown as NodeJS.ProcessEnv;
  beforeEach(() => resetPushCeilings());

  it("pushes from the target, pulls here under the image's name and untags the ref on both", async () => {
    const { calls, exec } = recorder();
    const { ran, spawn } = shells({ save: "true", load: "true" });
    const lines: string[] = [];
    await bringBack([{ image: "shop:deploy-1", ref: "reg/shop:k1" }], { authEnv, session, from: "Long House", log: (l) => lines.push(l), exec, spawn });
    expect(calls.map((c) => `${c.where} ${c.args.join(" ")}`)).toEqual([
      "there tag shop:deploy-1 reg/shop:k1",
      "there push --quiet reg/shop:k1",
      "there image rm reg/shop:k1",
      "here pull --quiet reg/shop:k1",
      "here tag reg/shop:k1 shop:deploy-1",
      "here image rm reg/shop:k1",
      "there image rm shop:deploy-1",
    ]);
    expect(ran).toEqual([]);
    expect(lines).toEqual([expect.stringMatching(/^\[build\] Pulled reg\/shop:k1 from the build registry as shop:deploy-1 \(\d+\.\ds\)$/)]);
  });

  it("copies over SSH when the push fails, and keeps the image there until the copy is done", async () => {
    const { calls, exec } = recorder((args) => args[0] === "push");
    const { ran, spawn } = shells({ save: "head -c 2097152 /dev/zero", load: "cat >/dev/null" });
    const lines: string[] = [];
    await bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv, session, from: "Long House", log: (l) => lines.push(l), exec, spawn });
    expect(calls.map((c) => `${c.where} ${c.args.join(" ")}`)).toEqual([
      "there tag shop:d reg/shop:k",
      "there push --quiet reg/shop:k",
      "there image rm reg/shop:k",
      "there image rm shop:d",
    ]);
    expect(ran).toEqual(["there save shop:d", "here load --quiet"]);
    expect(lines).toEqual([
      "[build] Couldn't use the build registry: couldn't push reg/shop:k from the target: unauthorized: authentication required",
      "[build] Registry unavailable; copying shop:d from Long House over SSH",
      expect.stringMatching(/^\[build\] Copied shop:d from Long House over SSH \(2 MB, \d+\.\ds\)$/),
    ]);
  });

  describe("a push cut off on a big layer", () => {
    const big = MIN_CEILING_BYTES * 4;
    const cut = "write: broken pipe";

    it("skips the registry next time for a layer that big, and copies over SSH", async () => {
      const first = recorder((args) => args[0] === "push", { layers: [1000, big], stderr: cut });
      const { spawn } = shells({ save: "true", load: "true" });
      await bringBack([{ image: "shop:d1", ref: "reg/shop:k1" }], { authEnv, session, from: "lh", log: () => {}, exec: first.exec, spawn });

      const second = recorder(undefined, { layers: [big * 2] });
      const lines: string[] = [];
      await bringBack([{ image: "shop:d2", ref: "reg/shop:k2" }], { authEnv, session, from: "lh", log: (l) => lines.push(l), exec: second.exec, spawn });
      expect(second.calls.some((c) => c.args[0] === "push")).toBe(false);
      expect(lines[0]).toBe("[build] Skipping the build registry for shop:d2: its 512 MB layer is at least the 256 MB one cut off pushing from lh");
      expect(lines[1]).toBe("[build] Copying shop:d2 from lh over SSH");
    });

    it("keeps pushing smaller images and other targets", async () => {
      const { spawn } = shells({ save: "true", load: "true" });
      await bringBack([{ image: "shop:d1", ref: "reg/shop:k1" }], { authEnv, session, from: "lh", log: () => {}, exec: recorder((a) => a[0] === "push", { layers: [big], stderr: cut }).exec, spawn });

      const small = recorder(undefined, { layers: [big / 2] });
      await bringBack([{ image: "shop:d2", ref: "reg/shop:k2" }], { authEnv, session, from: "lh", log: () => {}, exec: small.exec, spawn });
      expect(small.calls.some((c) => c.args[0] === "push")).toBe(true);

      const other = recorder(undefined, { layers: [big] });
      await bringBack([{ image: "shop:d3", ref: "reg/shop:k3" }], { authEnv, session, from: "box", log: () => {}, exec: other.exec, spawn });
      expect(other.calls.some((c) => c.args[0] === "push")).toBe(true);
    });

    it("learns nothing from a refused push or a small layer", async () => {
      const { spawn } = shells({ save: "true", load: "true" });
      await bringBack([{ image: "a:1", ref: "reg/a:1" }], { authEnv, session, from: "lh", log: () => {}, exec: recorder((a) => a[0] === "push", { layers: [big] }).exec, spawn });
      await bringBack([{ image: "b:1", ref: "reg/b:1" }], { authEnv, session, from: "lh", log: () => {}, exec: recorder((a) => a[0] === "push", { layers: [1000], stderr: cut }).exec, spawn });

      const next = recorder(undefined, { layers: [big] });
      await bringBack([{ image: "c:1", ref: "reg/c:1" }], { authEnv, session, from: "lh", log: () => {}, exec: next.exec, spawn });
      expect(next.calls.some((c) => c.args[0] === "push")).toBe(true);
    });
  });

  it("records how each image came back, with the times and bytes its log lines give", async () => {
    const { spawn } = shells({ save: "head -c 2097152 /dev/zero", load: "cat >/dev/null" });
    const placement = createBuildPlacement();
    placement.started({ id: "lh-id", name: "Long House" });
    const lines: string[] = [];
    await bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv, session, from: "Long House", log: (l) => lines.push(l), placement, exec: recorder().exec, spawn });
    expect(placement.columns()).toMatchObject({ imageTransfer: "registry", imageTransferBytes: null });
    const pulled = lines[0].match(/\((\d+\.\d)s\)$/)?.[1];
    expect(((placement.columns().imageTransferMs ?? -1) / 1000).toFixed(1)).toBe(pulled);

    const ssh = createBuildPlacement();
    ssh.started({ id: "lh-id", name: "Long House" });
    await bringBack([{ image: "shop:d", ref: null }], { authEnv, session, from: "Long House", log: () => {}, placement: ssh, exec: recorder().exec, spawn });
    expect(ssh.columns()).toMatchObject({ imageTransfer: "ssh", imageTransferBytes: 2_097_152 });
  });

  it("records an SSH copy that skipped the registry, and mixed ways across images", async () => {
    const big = MIN_CEILING_BYTES * 4;
    const { spawn } = shells({ save: "head -c 1000 /dev/zero", load: "cat >/dev/null" });
    await bringBack([{ image: "a:1", ref: "reg/a:1" }], { authEnv, session, from: "lh", log: () => {}, exec: recorder((a) => a[0] === "push", { layers: [big], stderr: "write: broken pipe" }).exec, spawn });

    const skipped = createBuildPlacement();
    skipped.started({ id: "lh", name: "lh" });
    await bringBack([{ image: "a:2", ref: "reg/a:2" }], { authEnv, session, from: "lh", log: () => {}, placement: skipped, exec: recorder(undefined, { layers: [big] }).exec, spawn });
    expect(skipped.columns()).toMatchObject({ imageTransfer: "registry_skipped", imageTransferBytes: 1000 });

    const mixed = createBuildPlacement();
    mixed.started({ id: "lh", name: "lh" });
    await bringBack(
      [{ image: "web", ref: null }, { image: "api", ref: "reg/api:k" }],
      { authEnv, session, from: "lh", log: () => {}, placement: mixed, exec: recorder(undefined, { layers: [1000] }).exec, spawn },
    );
    expect(mixed.columns()).toMatchObject({ imageTransfer: "mixed", imageTransferBytes: 1000 });
  });

  it("copies over SSH when the pull here fails", async () => {
    const { exec } = recorder((args) => args[0] === "pull");
    const { ran, spawn } = shells({ save: "true", load: "true" });
    const lines: string[] = [];
    await bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv, session, from: "lh", log: (l) => lines.push(l), exec, spawn });
    expect(ran).toEqual(["there save shop:d", "here load --quiet"]);
    expect(lines[0]).toMatch(/^\[build\] Couldn't use the build registry: couldn't pull reg\/shop:k here: unauthorized/);
  });

  it("copies over SSH with no registry, and skips the registry for the rest once it fails", async () => {
    const { calls, exec } = recorder((args) => args[0] === "push");
    const { ran, spawn } = shells({ save: "true", load: "true" });
    const lines: string[] = [];
    await bringBack(
      [{ image: "app-web", ref: null }, { image: "app-api", ref: "reg/app-api:k" }, { image: "app-worker", ref: "reg/app-worker:k" }],
      { authEnv, session, from: "lh", log: (l) => lines.push(l), exec, spawn },
    );
    expect(ran).toEqual(["there save app-web", "here load --quiet", "there save app-api", "here load --quiet", "there save app-worker", "here load --quiet"]);
    expect(calls.filter((c) => c.args[0] === "push").length).toBe(1);
    expect(lines[0]).toBe("[build] Copying app-web from lh over SSH");
    expect(lines).toContain("[build] Registry unavailable; copying app-worker from lh over SSH");
    expect(calls.at(-1)).toEqual({ args: ["image", "rm", "app-web", "app-api", "app-worker"], where: "there" });
  });

  it("blames the builder when both paths fail, and still cleans up there", async () => {
    const { calls, exec } = recorder((args) => args[0] === "push");
    const { spawn } = shells({ save: "echo 'error during connect: Broken pipe' >&2; exit 1", load: "cat >/dev/null" });
    const lines: string[] = [];
    const err = await bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv, session, from: "lh", log: (l) => lines.push(l), exec, spawn })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuilderError);
    expect((err as BuilderError).reason).toBe("couldn't copy shop:d here over SSH: the connection to it dropped");
    expect(lines.at(-1)).toBe("[build] Copying over SSH failed: docker save on the target failed (exit 1): error during connect: Broken pipe");
    expect(calls.at(-1)).toEqual({ args: ["image", "rm", "shop:d"], where: "there" });
  });

  it("doesn't fall back when the deploy is aborted", async () => {
    const abort = new AbortController();
    const { exec } = recorder((args) => {
      if (args[0] !== "push") return false;
      abort.abort();
      return true;
    });
    const { ran, spawn } = shells({ save: "true", load: "true" });
    const err = await bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv, session, from: "lh", log: () => {}, exec, spawn, signal: abort.signal })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BuilderError);
    expect(ran).toEqual([]);
  });
});
