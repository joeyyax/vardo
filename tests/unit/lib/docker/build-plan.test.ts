// Fixtures are real output from Railpack 0.35.0 and Nixpacks 1.41.0 on heroku/node-js-getting-started,
// a Flask app, a Next app with a pnpm lockfile and a repo with only a readme.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolves through promisify.custom, like the real execFile. Set before lib/utils/exec promisifies it.
const { execFile, execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const execFile = Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => execFileMock(...args),
  });
  return { execFile, execFileMock };
});
vi.mock("child_process", () => ({ execFile }));

const ok = (stdout: string) => () => Promise.resolve({ stdout, stderr: "" });

import {
  buildPlanLogLines,
  captureBuildPlan,
  maskPlanEnv,
  parseBuildPlan,
  providerMarkers,
  summarizeNixpacks,
  summarizeRailpack,
} from "@/lib/docker/build-plan";

const FIXTURES = join(__dirname, "fixtures/buildpack");
const raw = (name: string) => readFileSync(join(FIXTURES, `${name}.json`), "utf8");
const json = (name: string): unknown => JSON.parse(raw(name));

describe("summarizeRailpack", () => {
  it("reads provider, version source, commands and notes from a Node app", () => {
    const s = summarizeRailpack(json("rp-info-node"));
    expect(s.providers).toEqual(["node"]);
    expect(s.languages).toEqual(["node 22.23.3 (package.json > engines > node)"]);
    expect(s.install).toEqual(["mkdir -p /app/node_modules/.cache", "npm install"]);
    expect(s.build).toEqual([]);
    expect(s.start).toBe("node index.js");
    expect(s.notes).toContain("Found web command in Procfile");
    expect(s.errors).toEqual([]);
  });

  it("reads a Python app's runtime from its version file", () => {
    const s = summarizeRailpack(json("rp-info-py"));
    expect(s.providers).toEqual(["python"]);
    expect(s.languages).toEqual(["python 3.12.15 (idiomatic-version-file)"]);
    expect(s.install).toContain("pip install -r requirements.txt");
    expect(s.start).toBe("gunicorn --bind 0.0.0.0:${PORT:-8000} main:app");
  });

  it("lists the package manager alongside the runtime for a pnpm Next app", () => {
    const s = summarizeRailpack(json("rp-info-next"));
    expect(s.languages).toEqual(["node 22.23.3 (railpack default)", "pnpm 9.15.9 (railpack default)"]);
    expect(s.build).toEqual(["pnpm run build"]);
    expect(s.start).toBe("pnpm run start");
  });

  it("shows overrides where Railpack put them", () => {
    const s = summarizeRailpack(json("rp-info-node-override"));
    expect(s.build).toEqual(["sh -c 'npm run custom'"]);
    expect(s.start).toBe("node custom.js");
  });

  it("keeps the first line of Railpack's own error when it can't plan", () => {
    const s = summarizeRailpack(json("rp-info-empty"));
    expect(s.providers).toEqual([]);
    expect(s.errors).toEqual(["Railpack could not determine how to build the app."]);
    expect(s.start).toBeNull();
  });
});

describe("summarizeNixpacks", () => {
  it("reads provider, nix packages and commands from a Node app", () => {
    const s = summarizeNixpacks(json("nix-plan-node"));
    expect(s.providers).toEqual(["node"]);
    expect(s.languages).toEqual(["nodejs_24", "npm-9_x"]);
    expect(s.install).toEqual(["npm ci"]);
    expect(s.build).toEqual([]);
    expect(s.start).toBe("node index.js");
  });

  it("reads a Python app with no start command", () => {
    const s = summarizeNixpacks(json("nix-plan-py"));
    expect(s.providers).toEqual(["python"]);
    expect(s.languages).toEqual(["python312", "gcc"]);
    expect(s.start).toBeNull();
  });

  it("reads a pnpm Next app", () => {
    const s = summarizeNixpacks(json("nix-plan-next"));
    expect(s.install).toEqual(["pnpm i --frozen-lockfile"]);
    expect(s.build).toEqual(["pnpm run build"]);
    expect(s.start).toBe("pnpm run start");
  });

  it("shows overrides where Nixpacks put them", () => {
    const s = summarizeNixpacks(json("nix-plan-node-override"));
    expect(s.build).toEqual(["npm run custom"]);
    expect(s.start).toBe("node custom.js");
  });

  it("says so when no provider matched", () => {
    const s = summarizeNixpacks(json("nix-plan-empty"));
    expect(s.providers).toEqual([]);
    expect(s.errors).toEqual(["Nixpacks found no provider for this app."]);
  });
});

describe("maskPlanEnv", () => {
  it("masks app env values Nixpacks copied into the plan, and keeps its own", () => {
    const masked = maskPlanEnv(json("nix-plan-node-env"), ["SECRET_TOKEN", "NIXPACKS_NODE_VERSION"]);
    const text = JSON.stringify(masked);
    expect(raw("nix-plan-node-env")).toContain("supersecret123");
    expect(text).not.toContain("supersecret123");
    const vars = (masked as { variables: Record<string, string> }).variables;
    expect(vars.SECRET_TOKEN).toBe("***");
    expect(vars.NODE_ENV).toBe("production");
  });

  it("masks nested variables maps in a Railpack plan", () => {
    const masked = maskPlanEnv(json("rp-info-node"), ["NODE_ENV"]) as {
      plan: { steps: { name: string; variables?: Record<string, string> }[]; deploy: { variables: Record<string, string> } };
    };
    expect(masked.plan.steps.find((s) => s.name === "install")?.variables?.NODE_ENV).toBe("***");
    expect(masked.plan.deploy.variables.NODE_ENV).toBe("***");
    expect(masked.plan.deploy.variables.CI).toBe("true");
  });
});

describe("parseBuildPlan", () => {
  it("records engine, version, overrides and the files that led to the provider", () => {
    const record = parseBuildPlan("railpack", raw("rp-info-node-override"), {
      overrides: { buildCommand: "npm run custom", startCommand: " node custom.js " },
      markers: [
        { file: "Procfile", provider: "procfile" },
        { file: "package.json", provider: "node" },
        { file: "requirements.txt", provider: "python" },
      ],
    });
    expect(record.engine).toBe("railpack");
    expect(record.version).toBe("0.35.0");
    expect(record.overrides).toEqual({ buildCommand: "npm run custom", startCommand: "node custom.js" });
    expect(record.summary.evidence).toEqual(["Procfile", "package.json"]);
  });

  it("has no version for Nixpacks, whose plan doesn't carry one", () => {
    expect(parseBuildPlan("nixpacks", raw("nix-plan-node")).version).toBeNull();
  });

  it("throws on output that isn't JSON", () => {
    expect(() => parseBuildPlan("nixpacks", "error: nope")).toThrow(SyntaxError);
  });
});

describe("buildPlanLogLines", () => {
  it("says what was detected and why, then the commands", () => {
    const record = parseBuildPlan("railpack", raw("rp-info-node"), {
      markers: [{ file: "package.json", provider: "node" }, { file: "Procfile", provider: "procfile" }],
    });
    const lines = buildPlanLogLines(record);
    expect(lines[0]).toBe("[build] Plan from Railpack 0.35.0: node");
    expect(lines).toContain("[build]   Detected from: package.json, Procfile");
    expect(lines).toContain("[build]   Language: node 22.23.3 (package.json > engines > node)");
    expect(lines).toContain("[build]   Install: mkdir -p /app/node_modules/.cache && npm install");
    expect(lines).toContain("[build]   Build: none");
    expect(lines).toContain("[build]   Start: node index.js");
  });

  it("marks overridden commands", () => {
    const record = parseBuildPlan("nixpacks", raw("nix-plan-node-override"), {
      overrides: { buildCommand: "npm run custom", startCommand: "node custom.js" },
    });
    const lines = buildPlanLogLines(record);
    expect(lines).toContain("[build]   Build: npm run custom (override)");
    expect(lines).toContain("[build]   Start: node custom.js (override)");
  });

  it("logs the reason when there's no plan", () => {
    const lines = buildPlanLogLines(parseBuildPlan("nixpacks", raw("nix-plan-empty")));
    expect(lines[0]).toBe("[build] Plan from Nixpacks: no provider");
    expect(lines.at(-1)).toBe("[build]   Error: Nixpacks found no provider for this app.");
  });
});

describe("providerMarkers", () => {
  it("maps top-level files to providers and ignores the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markers-"));
    try {
      for (const f of ["package.json", "Procfile", "README.md", "app.csproj", "requirements.txt"]) {
        writeFileSync(join(dir, f), "");
      }
      expect(await providerMarkers(dir)).toEqual([
        { file: "Procfile", provider: "procfile" },
        { file: "app.csproj", provider: "dotnet" },
        { file: "package.json", provider: "node" },
        { file: "requirements.txt", provider: "python" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing for a missing directory", async () => {
    expect(await providerMarkers("/nonexistent/vardo-markers")).toEqual([]);
  });
});

describe("captureBuildPlan", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("runs railpack info with the plan args and an explicit env, then masks app env", async () => {
    execFileMock.mockImplementation(ok(raw("rp-info-node")));
    const record = await captureBuildPlan("railpack", "/repo", {
      envVars: { NODE_ENV: "secret-ish" },
      overrides: { startCommand: "node custom.js" },
    });
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("railpack");
    expect(args).toEqual(["info", "--format", "json", "--start-cmd", "node custom.js", "--env", "NODE_ENV=secret-ish", "/repo"]);
    expect(opts.env).toBeDefined();
    expect(opts.env.NODE_ENV).toBeUndefined();
    expect(record?.summary.providers).toEqual(["node"]);
    expect(JSON.stringify(record?.plan)).not.toContain('"NODE_ENV":"production"');
  });

  it("runs nixpacks plan", async () => {
    execFileMock.mockImplementation(ok(raw("nix-plan-py")));
    const record = await captureBuildPlan("nixpacks", "/repo");
    expect(execFileMock.mock.calls[0][0]).toBe("nixpacks");
    expect(execFileMock.mock.calls[0][1]).toEqual(["plan", "/repo", "--format", "json"]);
    expect(record?.summary.providers).toEqual(["python"]);
  });

  it("returns null and logs stderr, never argv, when the CLI fails", async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      Promise.reject(Object.assign(new Error(`Command failed: nixpacks ${args.join(" ")}`), { code: 1, stderr: "Error: boom\n" })),
    );
    const log = vi.fn();
    const record = await captureBuildPlan("nixpacks", "/repo", { envVars: { TOKEN: "hunter2" }, log });
    expect(record).toBeNull();
    expect(log).toHaveBeenCalledWith("[build] Couldn't read the Nixpacks plan: Error: boom");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("returns null when the output isn't JSON", async () => {
    execFileMock.mockImplementation(ok(""));
    const log = vi.fn();
    expect(await captureBuildPlan("railpack", "/repo", { log })).toBeNull();
    expect(log).toHaveBeenCalledWith("[build] Couldn't read the Railpack plan: output wasn't JSON");
  });
});
