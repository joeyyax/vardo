// ---------------------------------------------------------------------------
// Inline config and secret content, which compose's config hash leaves out.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeSharedOutcome,
  inlineFiles,
  reconcileSharedServices,
  sharedDrift,
  type DockerExec,
} from "@/lib/docker/deploy-steps/shared-drift";
import { definitionFingerprint } from "@/lib/docker/deploy-steps/shared-definitions";
import type { ComposeService } from "@/lib/docker/compose-types";

const HASH = "c".repeat(64);
const TARGET = "/etc/buildkit/buildkitd.toml";

const policy = (maxUsed: string, keep = true) =>
  `[worker.oci]\n  gc = true\n${keep ? '  [[worker.oci.gcpolicy]]\n    keepDuration = "168h"\n' : ""}` +
  `  [[worker.oci.gcpolicy]]\n    maxUsedSpace = "${maxUsed}"\n`;

const buildkitService = { image: "moby/buildkit:v0.34.0", container_name: "vardo-buildkit" };

/** `config --format json` for buildkit with the given (already interpolated) content. */
const configJson = (content: string, ref: unknown = { source: "buildkitd", target: TARGET }) =>
  JSON.stringify({
    services: { buildkit: { ...buildkitService, configs: [ref] } },
    configs: { buildkitd: { name: "vardo_buildkitd", content } },
  });

type Docker = {
  desiredContent: string;
  runningContent: string | null;
  runningHash?: string;
};

function docker(opts: Docker): DockerExec & ReturnType<typeof vi.fn> {
  return vi.fn(async (args: string[]) => {
    if (args.includes("config") && args.includes("--hash")) return { stdout: `buildkit ${HASH}\n`, stderr: "" };
    if (args.includes("config")) return { stdout: configJson(opts.desiredContent), stderr: "" };
    if (args[0] === "inspect" && args[2].includes("config-hash")) return { stdout: `${opts.runningHash ?? HASH}|\n`, stderr: "" };
    if (args[0] === "inspect") return { stdout: "running healthy\n", stderr: "" };
    if (args[0] === "exec") {
      expect(args).toEqual(["exec", "vardo-buildkit", "cat", TARGET]);
      if (opts.runningContent === null) throw new Error("executable file not found");
      return { stdout: opts.runningContent, stderr: "" };
    }
    if (args.includes("up")) return { stdout: "", stderr: "" };
    throw new Error(`unexpected: docker ${args.join(" ")}`);
  }) as DockerExec & ReturnType<typeof vi.fn>;
}

const base = (exec: DockerExec) => ({
  shared: {
    buildkit: { ...buildkitService, configs: [{ source: "buildkitd", target: TARGET }] },
  } as unknown as Record<string, ComposeService>,
  project: "vardo",
  composeFileArgs: ["-f", "docker-compose.yml"],
  cwd: "/opt/vardo/apps/vardo/production/green",
  exec,
  timeout: 1000,
});

const reconcile = (exec: DockerExec, extra: Partial<Parameters<typeof reconcileSharedServices>[0]> = {}) =>
  reconcileSharedServices({
    ...base(exec),
    log: () => {},
    upTimeout: 1000,
    readyTimeout: () => 1000,
    intervalMs: 1,
    stableMs: 0,
    sleep: async () => {},
    ...extra,
  });

const upCalls = (exec: ReturnType<typeof vi.fn>) =>
  exec.mock.calls.map((c) => c[0] as string[]).filter((a) => a.includes("up"));

describe("inlineFiles", () => {
  it("maps each service's inline config to its target", () => {
    expect(inlineFiles(configJson("x = 1\n"))).toEqual(new Map([["buildkit", new Map([[TARGET, "x = 1\n"]])]]));
  });

  it("uses compose's default targets", () => {
    const out = JSON.stringify({
      services: { app: { configs: ["conf"], secrets: [{ source: "token" }] } },
      configs: { conf: { content: "a" } },
      secrets: { token: { content: "b" } },
    });
    expect(inlineFiles(out).get("app")).toEqual(new Map([["/conf", "a"], ["/run/secrets/token", "b"]]));
  });

  it("skips file-backed configs, which are bind mounts", () => {
    const out = JSON.stringify({
      services: { app: { configs: ["conf"] } },
      configs: { conf: { file: "/opt/conf" } },
    });
    expect(inlineFiles(out).size).toBe(0);
  });

  it("unescapes the $$ that config keeps, as the container sees it", () => {
    expect(inlineFiles(configJson("a=$$HOME b=$${X:-1}\n")).get("buildkit")).toEqual(new Map([[TARGET, "a=$HOME b=${X:-1}\n"]]));
  });

  it("is empty for output that isn't JSON", () => {
    expect(inlineFiles("WARN something").size).toBe(0);
  });
});

describe("sharedDrift with inline configs", () => {
  it("calls a service drifted when its config content changed under the same hash", async () => {
    const exec = docker({ desiredContent: policy("23622320128"), runningContent: policy("23622320128", false) });
    const { states, contentChanged } = await sharedDrift(base(exec));
    expect(states.get("buildkit")).toBe("drifted");
    expect(contentChanged.has("buildkit")).toBe(true);
  });

  it("calls a changed interpolated value drift", async () => {
    const exec = docker({ desiredContent: policy("34359738368"), runningContent: policy("10737418240") });
    expect((await sharedDrift(base(exec))).states.get("buildkit")).toBe("drifted");
  });

  it("leaves matching content unchanged", async () => {
    const content = policy("23622320128");
    const exec = docker({ desiredContent: content, runningContent: content });
    const { states, contentChanged } = await sharedDrift(base(exec));
    expect(states.get("buildkit")).toBe("unchanged");
    expect(contentChanged.size).toBe(0);
  });

  it("judges by hash alone when the file can't be read", async () => {
    const exec = docker({ desiredContent: policy("1"), runningContent: null });
    expect((await sharedDrift(base(exec))).states.get("buildkit")).toBe("unchanged");
  });

  it("doesn't read files of a service already drifted by hash", async () => {
    const exec = docker({ desiredContent: policy("1"), runningContent: policy("1"), runningHash: "d".repeat(64) });
    expect((await sharedDrift(base(exec))).states.get("buildkit")).toBe("drifted");
    expect(exec.mock.calls.some((c) => (c[0] as string[])[0] === "exec")).toBe(false);
  });

  describe("with a recorded fingerprint", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "shared-content-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("still recreates when only labels differ but the content changed", async () => {
      const file = join(dir, "shared-definitions.json");
      const desired = policy("2");
      const print = definitionFingerprint(JSON.parse(configJson(desired)).services.buildkit);
      const running = "e".repeat(64);
      writeFileSync(file, JSON.stringify({ services: { buildkit: { hash: running, fingerprint: print } } }));
      const exec = docker({ desiredContent: desired, runningContent: policy("1"), runningHash: running });
      const { states, labelsOnly, contentChanged } = await sharedDrift({ ...base(exec), definitionsFile: file });
      expect(states.get("buildkit")).toBe("drifted");
      expect(labelsOnly.has("buildkit")).toBe(false);
      expect(contentChanged.has("buildkit")).toBe(true);
    });
  });
});

describe("reconcileSharedServices with inline configs", () => {
  it("recreates a service whose config changed", async () => {
    const exec = docker({ desiredContent: policy("2"), runningContent: policy("1") });
    const lines: string[] = [];
    const outcomes = await reconcile(exec, { log: (l) => lines.push(l) });
    expect(outcomes).toEqual([{ service: "buildkit", result: "recreated", contentChanged: true }]);
    expect(upCalls(exec)).toHaveLength(1);
    expect(lines.join("\n")).toContain("a config or secret it mounts changed");
    expect(describeSharedOutcome(outcomes[0])).toContain("recreated with its new config");
  });

  it("holds the recreate when the caller says to", async () => {
    const exec = docker({ desiredContent: policy("2"), runningContent: policy("1") });
    const holdRecreate = vi.fn(async () => "other deploys are running");
    const outcomes = await reconcile(exec, { holdRecreate });
    expect(holdRecreate).toHaveBeenCalledWith("buildkit", "vardo-buildkit");
    expect(outcomes).toEqual([{ service: "buildkit", result: "held", reason: "other deploys are running" }]);
    expect(upCalls(exec)).toHaveLength(0);
  });

  it("doesn't ask to hold an unchanged service", async () => {
    const content = policy("1");
    const exec = docker({ desiredContent: content, runningContent: content });
    const holdRecreate = vi.fn(async () => "busy");
    expect(await reconcile(exec, { holdRecreate })).toEqual([{ service: "buildkit", result: "unchanged" }]);
    expect(holdRecreate).not.toHaveBeenCalled();
  });
});
