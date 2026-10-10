import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "util";

// ---------------------------------------------------------------------------
// Builds run in the BuildKit container, whose memory limit bounds them all.
// Without it they fall back to the daemon, and say they are unbounded.
// ---------------------------------------------------------------------------

const { execFileMock, calls, answers } = vi.hoisted(() => ({
  execFileMock: vi.fn() as unknown as Record<symbol, unknown>,
  calls: [] as { args: string[]; env?: NodeJS.ProcessEnv }[],
  answers: { running: true, builderExists: true, createFails: false, memory: String(12 * 1024 ** 3) },
}));

(execFileMock as Record<symbol, unknown>)[promisify.custom] = async (
  _cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
) => {
  calls.push({ args, env: opts?.env });
  const line = args.join(" ");
  if (line.includes("{{.State.Running}}")) return { stdout: answers.running ? "true\n" : "false\n", stderr: "" };
  if (line.includes("{{.HostConfig.Memory}}")) return { stdout: `${answers.memory}\n`, stderr: "" };
  if (line.startsWith("buildx inspect")) {
    if (answers.builderExists) return { stdout: "", stderr: "" };
    throw new Error("no builder");
  }
  if (line.startsWith("buildx create")) {
    if (answers.createFails) {
      answers.builderExists = true;
      throw new Error("existing instance");
    }
    answers.builderExists = true;
    return { stdout: "", stderr: "" };
  }
  return { stdout: "", stderr: "" };
};

vi.mock("child_process", () => ({ execFile: execFileMock }));

const { boundedBuild, explainBuildOom, isBuildOom } = await import("@/lib/docker/build-memory");

const lines: string[] = [];
const log = (line: string) => void lines.push(line);

beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  Object.assign(answers, { running: true, builderExists: true, createFails: false, memory: String(12 * 1024 ** 3) });
  delete process.env.VARDO_BUILD_BUILDER;
  delete process.env.BUILDKIT_HOST;
});

afterEach(() => {
  delete process.env.VARDO_BUILD_BUILDER;
});

describe("boundedBuild", () => {
  it("builds in the BuildKit container and loads the result into the daemon", async () => {
    const build = await boundedBuild(log);

    expect(build.env.BUILDX_BUILDER).toBe("vardo-bounded");
    expect(build.env.BUILDX_CONFIG).toMatch(/buildx$/);
    expect(build.loadArgs).toEqual(["--load"]);
    expect(build.limitBytes).toBe(12 * 1024 ** 3);
    expect(lines.join("\n")).toContain("memory limit 12 GiB");
  });

  it("registers the builder against the container when it is missing", async () => {
    answers.builderExists = false;

    await boundedBuild(log);

    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.args).toEqual([
      "buildx", "create", "--name", "vardo-bounded", "--driver", "remote", "docker-container://vardo-buildkit",
    ]);
  });

  it("uses the builder a concurrent deploy registered first", async () => {
    answers.builderExists = false;
    answers.createFails = true;

    expect((await boundedBuild(log)).env.BUILDX_BUILDER).toBe("vardo-bounded");
  });

  it("falls back to the daemon, and says so, when BuildKit is not running", async () => {
    answers.running = false;

    const build = await boundedBuild(log);

    expect(build.env).toEqual({});
    expect(build.limitBytes).toBeNull();
    expect(lines.join("\n")).toMatch(/no memory limit/);
  });

  it("honors an explicit opt-out", async () => {
    process.env.VARDO_BUILD_BUILDER = "daemon";

    expect((await boundedBuild(log)).env).toEqual({});
    expect(calls).toEqual([]);
  });

  it("warns when the container itself has no limit", async () => {
    answers.memory = "0";

    await boundedBuild(log);

    expect(lines.join("\n")).toMatch(/has no memory limit/);
  });
});

describe("explainBuildOom", () => {
  const bounded = { env: {}, loadArgs: [], limitBytes: 4 * 1024 ** 3 };

  it("recognizes BuildKit's out-of-memory failure", () => {
    expect(isBuildOom('ResourceExhausted: process "/bin/sh -c x" did not complete successfully: cannot allocate memory')).toBe(true);
    expect(isBuildOom("exit code: 137")).toBe(true);
    expect(isBuildOom("npm ERR! missing script: build")).toBe(false);
  });

  it("rewrites an OOM into an error naming the limit", () => {
    const err = explainBuildOom(new Error("cannot allocate memory"), bounded) as Error;

    expect(err.message).toMatch(/ran out of memory \(4 GiB\)/);
    expect(err.message).toMatch(/sed -i 's\/\^VARDO_BUILDKIT_MEM=\.\*\/VARDO_BUILDKIT_MEM=8g\/' \S+\/\.env && sudo vardo update/);
  });

  it("doubles a larger limit in the command it gives", () => {
    const err = explainBuildOom(new Error("exit code: 137"), { ...bounded, limitBytes: 6 * 1024 ** 3 }) as Error;

    expect(err.message).toContain("VARDO_BUILDKIT_MEM=12g");
  });

  it("passes other failures through untouched", () => {
    const original = new Error("npm ERR! missing script: build");

    expect(explainBuildOom(original, bounded)).toBe(original);
  });

  it("leaves a daemon build's failure alone — no limit was in play", () => {
    const original = new Error("cannot allocate memory");

    expect(explainBuildOom(original, { env: {}, loadArgs: [], limitBytes: null })).toBe(original);
  });
});
