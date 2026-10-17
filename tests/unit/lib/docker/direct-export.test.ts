// A peer's BuildKit sending images straight here: pushed to the registry and pulled, else a docker tarball loaded here.

import { describe, it, expect, beforeEach } from "vitest";
import { access, writeFile } from "fs/promises";
import { dirname } from "path";
import { bringDirect, pushedName, registryOutput, resetDirectExport } from "@/lib/docker/direct-export";
import { MIN_CEILING_BYTES, resetPushCeilings } from "@/lib/docker/remote-build";
import { BuilderError } from "@/lib/docker/build-targets";
import type { Transfer } from "@/lib/docker/build-placement";

const REF = "registry.example.com/vardo/shop:k1";
const FILE = "type=docker,compression=zstd";

/** Records docker calls here; `history` answers with `layers`. */
function recorder(fail?: (args: string[]) => boolean, layers: number[] = [1000]) {
  const calls: string[] = [];
  const exec = async (_cmd: string, args: string[], o: Record<string, unknown>) => {
    if (args[0] === "history") return { stdout: layers.join("\n") };
    calls.push(`${(o.env as NodeJS.ProcessEnv).DOCKER_HOST ? "there" : "here"} ${args.join(" ")}`);
    if (fail?.(args)) throw Object.assign(new Error("failed"), { stderr: "Error response from daemon: manifest unknown" });
    return { stdout: "" };
  };
  return { calls, exec };
}

/** A build that writes a tarball for each file output, or fails per `fail`. */
function builder(fail: (outputs: string[], run: number) => Error | null = () => null) {
  const runs: string[][] = [];
  const build = async (outputs: string[]) => {
    runs.push(outputs);
    const err = fail(outputs, runs.length);
    if (err) throw err;
    for (const o of outputs) {
      const dest = o.match(/dest=(.+)$/)?.[1];
      if (dest) await writeFile(dest, Buffer.alloc(2048));
    }
  };
  return { runs, build };
}

const pushFailed = (detail: string) =>
  Object.assign(new Error("docker failed (exit 1)"), {
    stderr: `#6 exporting to image\nERROR: failed to push ${REF}: failed to copy: ${detail}\n`,
  });

function run(images: { image: string; ref: string | null }[], exec: ReturnType<typeof recorder>["exec"], build: (o: string[]) => Promise<void>, signal?: AbortSignal) {
  const lines: string[] = [];
  const transfers: Transfer[] = [];
  const placement = { transferred: (t: Transfer) => void transfers.push(t) };
  const done = bringDirect(images, {
    authEnv: {} as NodeJS.ProcessEnv, from: "Long House", log: (l) => void lines.push(l), compression: "zstd", build, exec, fileOutput: FILE, signal, placement,
  });
  return { lines, done, transfers };
}

beforeEach(() => {
  resetPushCeilings();
  resetDirectExport();
});

describe("registryOutput", () => {
  it("pushes zstd as OCI and gzip plainly", () => {
    expect(registryOutput(REF, "zstd")).toBe(`type=image,name=${REF},push=true,compression=zstd,oci-mediatypes=true`);
    expect(registryOutput(REF, "gzip")).toBe(`type=image,name=${REF},push=true,compression=gzip`);
  });
});

describe("pushedName", () => {
  it("names the ref a pushing output sends, and nothing for other outputs", () => {
    expect(pushedName(registryOutput(REF, "zstd"))).toBe(REF);
    expect(pushedName(`${FILE},dest=/tmp/x.tar`)).toBeNull();
    expect(pushedName(`type=image,name=${REF}`)).toBeNull();
  });
});

describe("bringDirect", () => {
  it("reruns to a tarball when a push fails without naming the registry", async () => {
    const r = recorder();
    const denied = Object.assign(new Error("docker failed (exit 1)"), {
      stderr: "ERROR: failed to push host/shop:d: push access denied, repository does not exist or may require authorization\n",
    });
    const b = builder((_o, n) => (n === 1 ? denied : null));
    const { done, transfers } = run([{ image: "shop:d", ref: REF }], r.exec, b.build);
    await done;
    expect(transfers.map((t) => t.via)).toEqual(["ssh"]);
    expect(b.runs.map((o) => o[0].split(",")[0])).toEqual(["type=image", "type=docker"]);
  });

  it("pushes from BuildKit to the registry and pulls here, leaving nothing on the target's daemon", async () => {
    const r = recorder();
    const b = builder();
    const { lines, done, transfers } = run([{ image: "shop:d", ref: REF }], r.exec, b.build);
    await done;
    expect(transfers).toEqual([{ via: "registry", ms: expect.any(Number) }]);
    expect(b.runs).toEqual([[registryOutput(REF, "zstd")]]);
    expect(r.calls).toEqual([`here pull --quiet ${REF}`, `here tag ${REF} shop:d`, `here image rm ${REF}`]);
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[build\\] Pulled ${REF} from the build registry as shop:d \\(\\d+\\.\\ds\\)$`))]);
  });

  it("exports a docker tarball here and loads it without a registry, then removes it", async () => {
    const r = recorder();
    const b = builder();
    const { lines, done, transfers } = run([{ image: "shop:d", ref: null }], r.exec, b.build);
    await done;
    expect(transfers).toEqual([{ via: "ssh", ms: expect.any(Number), bytes: 2048 }]);
    const dest = b.runs[0][0].match(/dest=(.+)$/)![1];
    expect(b.runs[0][0]).toBe(`${FILE},dest=${dest}`);
    expect(r.calls).toEqual([`here load --quiet -i ${dest}`]);
    expect(lines).toEqual([
      "[build] Copying shop:d from Long House over SSH",
      expect.stringMatching(/^\[build\] Copied shop:d from Long House over SSH \(2(\.0)? KB, \d+\.\ds\)$/),
    ]);
    expect(await access(dirname(dest)).then(() => true, () => false)).toBe(false);
  });

  it("reruns the build to a tarball when the push fails", async () => {
    const r = recorder();
    const b = builder((_o, n) => (n === 1 ? pushFailed("unexpected status from PUT request: 500") : null));
    const { lines, done, transfers } = run([{ image: "shop:d", ref: REF }], r.exec, b.build);
    await done;
    expect(transfers.map((t) => t.via)).toEqual(["ssh"]);
    expect(b.runs.map((o) => o[0].split(",")[0])).toEqual(["type=image", "type=docker"]);
    expect(lines[0]).toBe(`[build] Couldn't use the build registry: couldn't push ${REF} from the target: ERROR: failed to push ${REF}: failed to copy: unexpected status from PUT request: 500`);
    expect(lines[1]).toBe("[build] Registry unavailable; copying shop:d from Long House over SSH");
    expect(r.calls.some((c) => c.startsWith("here pull"))).toBe(false);
  });

  it("learns a push ceiling from a push cut off in BuildKit and sends that image straight to a tarball next time", async () => {
    const big = MIN_CEILING_BYTES * 2;
    const first = builder((_o, n) => (n === 1 ? pushFailed("write tcp: broken pipe") : null));
    await run([{ image: "shop:d1", ref: REF }], recorder(undefined, [1000, big]).exec, first.build).done;

    const next = builder();
    const { lines, done, transfers } = run([{ image: "shop:d2", ref: REF }], recorder(undefined, [1000, big]).exec, next.build);
    await done;
    expect(transfers).toEqual([{ via: "registry_skipped", ms: expect.any(Number), bytes: 2048 }]);
    expect(next.runs).toHaveLength(1);
    expect(next.runs[0][0].startsWith(`${FILE},dest=`)).toBe(true);
    expect(lines[0]).toBe("[build] Skipping the build registry for shop:d2: its 128 MB layer is at least the 128 MB one cut off pushing from Long House");
    expect(lines[1]).toBe("[build] Copying shop:d2 from Long House over SSH");
  });

  it("sets no ceiling for a small image or a push the registry refused", async () => {
    const small = builder((_o, n) => (n === 1 ? pushFailed("broken pipe") : null));
    await run([{ image: "shop:d1", ref: REF }], recorder().exec, small.build).done;
    const refused = builder((_o, n) => (n === 1 ? pushFailed("unauthorized: authentication required") : null));
    await run([{ image: "shop:d2", ref: REF }], recorder(undefined, [MIN_CEILING_BYTES * 2]).exec, refused.build).done;
    const next = builder();
    await run([{ image: "shop:d3", ref: REF }], recorder().exec, next.build).done;
    expect(next.runs[0][0].startsWith("type=image")).toBe(true);
  });

  it("rebuilds to a tarball when the pull here fails", async () => {
    const r = recorder((args) => args[0] === "pull");
    const b = builder();
    const { lines, done } = run([{ image: "shop:d", ref: REF }], r.exec, b.build);
    await done;
    expect(b.runs.map((o) => o[0].split(",")[0])).toEqual(["type=image", "type=docker"]);
    expect(lines[0]).toBe(`[build] Couldn't use the build registry: couldn't pull ${REF} here: Error response from daemon: manifest unknown`);
    expect(lines[1]).toBe("[build] Registry unavailable; copying shop:d from Long House over SSH");
  });

  it("leaves the app's own build failure alone", async () => {
    const b = builder(() => Object.assign(new Error("docker failed (exit 1)"), { stderr: 'ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1' }));
    await expect(run([{ image: "shop:d", ref: REF }], recorder().exec, b.build).done).rejects.toThrow("docker failed");
    expect(b.runs).toHaveLength(1);
  });

  it("blames the builder when loading fails", async () => {
    const r = recorder((args) => args[0] === "load");
    const err = await run([{ image: "shop:d", ref: null }], r.exec, builder().build).done.catch((e) => e);
    expect(err).toBeInstanceOf(BuilderError);
    expect((err as BuilderError).reason).toMatch(/^couldn't copy shop:d here over SSH/);
  });

  it("doesn't rerun once the deploy is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const b = builder(() => pushFailed("broken pipe"));
    await expect(run([{ image: "shop:d", ref: REF }], recorder().exec, b.build, ac.signal).done).rejects.toThrow();
    expect(b.runs).toHaveLength(1);
  });

  it("gives each image its own output and caches the ones already here on a rerun", async () => {
    const r = recorder((args) => args[0] === "pull" && args[2].includes("web"));
    const b = builder();
    const web = "registry.example.com/vardo/shop-web:k1";
    await run([{ image: "shop-api:d", ref: REF }, { image: "shop-web:d", ref: web }], r.exec, b.build).done;
    expect(b.runs[0]).toEqual([registryOutput(REF, "zstd"), registryOutput(web, "zstd")]);
    expect(b.runs[1][0]).toBe("type=cacheonly");
    expect(b.runs[1][1].startsWith(`${FILE},dest=`)).toBe(true);
  });
});
