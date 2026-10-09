// Buildpack plans: captured before the build, stored on the deployment and summarized in the deploy log.

import { readdir } from "fs/promises";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "./docker-env";
import {
  nixpacksPlanArgs,
  railpackPlanArgs,
  type BuildOverrides,
  type BuildpackEngine,
} from "./buildpack-args";

const PLAN_TIMEOUT = 60_000;
const PLAN_MAX_BUFFER = 4 * 1024 * 1024;

export type BuildPlanSummary = {
  /** Providers the engine picked, e.g. "node". */
  providers: string[];
  /** Repo files that point to those providers. */
  evidence: string[];
  /** The engine's own detection notes. */
  notes: string[];
  /** Language runtimes with versions, e.g. "node 22.23.3". */
  languages: string[];
  install: string[];
  build: string[];
  start: string | null;
  /** Why the engine couldn't plan. */
  errors: string[];
};

/** Stored on `deployment.build_plan`. */
export type BuildPlanRecord = {
  engine: BuildpackEngine;
  version: string | null;
  overrides: { buildCommand: string | null; startCommand: string | null };
  summary: BuildPlanSummary;
  /** The CLI's JSON with app env values masked. */
  plan: unknown;
};

/** Repo files each provider detects on. */
const MARKERS: { provider: string; files: RegExp }[] = [
  { provider: "node", files: /^(package\.json|bun\.lockb?|\.nvmrc|\.node-version)$/ },
  { provider: "python", files: /^(requirements\.txt|pyproject\.toml|Pipfile|setup\.py|uv\.lock|poetry\.lock|\.python-version)$/ },
  { provider: "go", files: /^(go\.mod|main\.go)$/ },
  { provider: "ruby", files: /^(Gemfile|\.ruby-version)$/ },
  { provider: "php", files: /^(composer\.json|index\.php)$/ },
  { provider: "rust", files: /^Cargo\.toml$/ },
  { provider: "java", files: /^(pom\.xml|build\.gradle(\.kts)?|gradlew)$/ },
  { provider: "elixir", files: /^mix\.exs$/ },
  { provider: "deno", files: /^deno\.jsonc?$/ },
  { provider: "dotnet", files: /\.(csproj|fsproj|sln)$/ },
  { provider: "gleam", files: /^gleam\.toml$/ },
  { provider: "cpp", files: /^(CMakeLists\.txt|meson\.build)$/ },
  { provider: "staticfile", files: /^(Staticfile|index\.html)$/ },
  { provider: "shell", files: /^start\.sh$/ },
  { provider: "procfile", files: /^Procfile$/ },
];

export type ProviderMarker = { file: string; provider: string };

/** Top-level repo files that point to a provider, in directory order. */
export async function providerMarkers(root: string): Promise<ProviderMarker[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found: ProviderMarker[] = [];
  for (const file of [...entries].sort()) {
    const match = MARKERS.find((m) => m.files.test(file));
    if (match) found.push({ file, provider: match.provider });
  }
  return found;
}

/** "package.json (node), Procfile" — the files a provider choice rests on. */
export function describeMarkers(markers: ProviderMarker[]): string {
  return markers
    .map((m) => (m.provider === "procfile" ? m.file : `${m.file} (${m.provider})`))
    .join(", ");
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** Masks app env values in every `variables` map. Nixpacks copies `--env` values into its plan. */
export function maskPlanEnv(plan: unknown, envKeys: Iterable<string>): unknown {
  const keys = new Set(envKeys);
  if (keys.size === 0) return plan;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    const obj = asObject(node);
    if (!obj) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const vars = k === "variables" ? asObject(v) : null;
      out[k] = vars
        ? Object.fromEntries(Object.entries(vars).map(([vk, vv]) => [vk, keys.has(vk) ? "***" : vv]))
        : walk(v);
    }
    return out;
  };
  return walk(plan);
}

function emptySummary(): BuildPlanSummary {
  return { providers: [], evidence: [], notes: [], languages: [], install: [], build: [], start: null, errors: [] };
}

/** Summary of `railpack info --format json` output. */
export function summarizeRailpack(info: unknown): BuildPlanSummary {
  const summary = emptySummary();
  const root = asObject(info);
  if (!root) return summary;
  summary.providers = strings(root.detectedProviders);

  for (const pkg of Object.values(asObject(root.resolvedPackages) ?? {})) {
    const p = asObject(pkg);
    if (!p || typeof p.name !== "string") continue;
    const version = typeof p.resolvedVersion === "string" ? ` ${p.resolvedVersion}` : "";
    const source = typeof p.source === "string" ? ` (${p.source})` : "";
    summary.languages.push(`${p.name}${version}${source}`);
  }

  for (const entry of Array.isArray(root.logs) ? root.logs : []) {
    const l = asObject(entry);
    if (!l || typeof l.Msg !== "string") continue;
    if (l.Level === "error") summary.errors.push(l.Msg.split("\n")[0]);
    else summary.notes.push(l.Msg);
  }

  const plan = asObject(root.plan);
  for (const step of Array.isArray(plan?.steps) ? plan.steps : []) {
    const s = asObject(step);
    const name = typeof s?.name === "string" ? s.name : "";
    const bucket = name.startsWith("install") ? summary.install : name.startsWith("build") ? summary.build : null;
    if (!bucket) continue;
    for (const c of Array.isArray(s?.commands) ? s.commands : []) {
      const cmd = asObject(c)?.cmd;
      if (typeof cmd === "string") bucket.push(cmd);
    }
  }
  const start = asObject(plan?.deploy)?.startCommand;
  summary.start = typeof start === "string" && start ? start : null;
  if (summary.providers.length === 0 && summary.errors.length === 0) {
    summary.errors.push("Railpack could not determine how to build the app.");
  }
  return summary;
}

/** Summary of `nixpacks plan --format json` output. */
export function summarizeNixpacks(plan: unknown): BuildPlanSummary {
  const summary = emptySummary();
  const root = asObject(plan);
  if (!root) return summary;
  const meta = asObject(root.variables)?.NIXPACKS_METADATA;
  summary.providers = typeof meta === "string" ? meta.split(",").map((p) => p.trim()).filter(Boolean) : [];
  summary.providers.push(...strings(root.providers).filter((p) => !summary.providers.includes(p)));

  const phases = asObject(root.phases) ?? {};
  summary.languages = strings(asObject(phases.setup)?.nixPkgs);
  summary.install = strings(asObject(phases.install)?.cmds);
  summary.build = strings(asObject(phases.build)?.cmds);
  const start = asObject(root.start)?.cmd;
  summary.start = typeof start === "string" && start ? start : null;
  if (summary.providers.length === 0) {
    summary.errors.push("Nixpacks found no provider for this app.");
  }
  return summary;
}

/** Parses a plan command's stdout into a record. Throws on output that isn't JSON. */
export function parseBuildPlan(
  engine: BuildpackEngine,
  stdout: string,
  opts: { envKeys?: Iterable<string>; overrides?: BuildOverrides; markers?: ProviderMarker[] } = {},
): BuildPlanRecord {
  const raw: unknown = JSON.parse(stdout);
  const summary = engine === "railpack" ? summarizeRailpack(raw) : summarizeNixpacks(raw);
  summary.evidence = (opts.markers ?? [])
    .filter((m) => m.provider === "procfile" || summary.providers.includes(m.provider))
    .map((m) => m.file);
  const version = engine === "railpack" ? asObject(raw)?.railpackVersion : null;
  return {
    engine,
    version: typeof version === "string" ? version : null,
    overrides: {
      buildCommand: opts.overrides?.buildCommand?.trim() || null,
      startCommand: opts.overrides?.startCommand?.trim() || null,
    },
    summary,
    plan: maskPlanEnv(raw, opts.envKeys ?? []),
  };
}

export const ENGINE_NAME: Record<BuildpackEngine, string> = { railpack: "Railpack", nixpacks: "Nixpacks" };

/** Deploy log lines for a plan. */
export function buildPlanLogLines(record: BuildPlanRecord): string[] {
  const { summary: s } = record;
  const engine = `${ENGINE_NAME[record.engine]}${record.version ? ` ${record.version}` : ""}`;
  const none = "none";
  const lines = [`[build] Plan from ${engine}: ${s.providers.join(", ") || "no provider"}`];
  if (s.evidence.length > 0) lines.push(`[build]   Detected from: ${s.evidence.join(", ")}`);
  if (s.notes.length > 0) lines.push(`[build]   Notes: ${s.notes.join("; ")}`);
  if (s.languages.length > 0) lines.push(`[build]   Language: ${s.languages.join(", ")}`);
  lines.push(`[build]   Install: ${s.install.join(" && ") || none}`);
  lines.push(`[build]   Build: ${s.build.join(" && ") || none}${record.overrides.buildCommand ? " (override)" : ""}`);
  lines.push(`[build]   Start: ${s.start ?? none}${record.overrides.startCommand ? " (override)" : ""}`);
  for (const e of s.errors) lines.push(`[build]   Error: ${e}`);
  return lines;
}

/** Runs the engine's plan command. Returns null when the CLI fails or prints something unparseable. */
export async function captureBuildPlan(
  engine: BuildpackEngine,
  repoPath: string,
  opts: {
    envVars?: Record<string, string>;
    overrides?: BuildOverrides;
    markers?: ProviderMarker[];
    log?: (line: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<BuildPlanRecord | null> {
  // App vars go in --env only, never the process env.
  const env = dockerEnv();
  const limits = { cwd: repoPath, timeout: PLAN_TIMEOUT, maxBuffer: PLAN_MAX_BUFFER, signal: opts.signal };
  try {
    const { stdout } = engine === "railpack"
      ? await execFileAsync("railpack", railpackPlanArgs(repoPath, opts.envVars, opts.overrides), { ...limits, env })
      : await execFileAsync("nixpacks", nixpacksPlanArgs(repoPath, opts.envVars, opts.overrides), { ...limits, env });
    return parseBuildPlan(engine, String(stdout), {
      envKeys: Object.keys(opts.envVars ?? {}),
      overrides: opts.overrides,
      markers: opts.markers,
    });
  } catch (err) {
    opts.log?.(`[build] Couldn't read the ${ENGINE_NAME[engine]} plan: ${planErrorReason(err)}`);
    return null;
  }
}

/** Stderr's last line or the exit code. The error message itself carries argv, and argv carries env values. */
function planErrorReason(err: unknown): string {
  if (err instanceof SyntaxError) return "output wasn't JSON";
  const e = err as { stderr?: unknown; code?: unknown; killed?: boolean };
  if (e.killed) return "timed out";
  const lastLine = typeof e.stderr === "string" ? e.stderr.trim().split("\n").at(-1) : "";
  return lastLine || (e.code !== undefined ? `exit ${String(e.code)}` : "unknown error");
}
