#!/usr/bin/env tsx
/**
 * One-off: copy an app's or compose's env from the Dokploy API into a named Vardo app.
 *
 * Usage:
 *   tsx scripts/dokploy-env-import.ts --from application:<id> --app <vardo-app-name> [options]
 *   tsx scripts/dokploy-env-import.ts --from compose:<id> --app <vardo-app-name> [options]
 *
 * Options:
 *   --dry-run         List variable names only. Reads Dokploy, writes nothing, never prints values.
 *   --overwrite       Replace an env the Vardo app already has. Without it the script stops.
 *   --keep-dollars    Leave `$$` as is. By default it becomes `$`, since Vardo escapes `$` itself.
 *   --dokploy-url     Dokploy base URL. Default: DOKPLOY_URL.
 *   --vardo-url       Vardo base URL. Default: VARDO_URL or http://localhost:3000.
 *   --org             Vardo organization ID. Default: the first one the token belongs to.
 *
 * Environment:
 *   DOKPLOY_API_KEY   Dokploy API key (required).
 *   VARDO_API_KEY     Vardo API token (required unless --dry-run).
 *
 * Resolves `${{project.X}}`, `${{environment.X}}` and `${{X}}` the way Dokploy does at deploy.
 * Vardo encrypts the env when its env-vars endpoint saves it.
 */

import { parse } from "dotenv";
import { formatEnvVar } from "../lib/env/dotenv";

export interface DokployEnvEntry {
  key: string;
  value: string;
}

export interface VardoEnvResult {
  content: string;
  /** Names written. */
  written: string[];
  /** Names Vardo can't use as variable names (letters, digits and underscores only). */
  skipped: string[];
  /** Names whose `$$` was turned back into `$`. */
  unescaped: string[];
  /** Names whose value still references a Dokploy variable (`${{...}}`) after resolving. */
  unresolved: string[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOUBLE_DOLLAR_RE = /\$\$/g;
const DOKPLOY_REF_RE = /\$\{\{[^}]*\}\}/;

/** Parses Dokploy's env text the way Dokploy does: with `dotenv`. Quoted values may span lines and `\n` expands inside double quotes. */
export function parseDokployEnv(text: string): DokployEnvEntry[] {
  return Object.entries(parse(text)).map(([key, value]) => ({ key, value }));
}

export interface DokployEnvSources {
  env: string;
  projectEnv: string;
  environmentEnv: string;
}

export interface ResolveResult {
  entries: DokployEnvEntry[];
  /** Names whose value had at least one reference replaced. */
  resolved: string[];
}

const PROJECT_REF_RE = /\$\{\{project\.(.*?)\}\}/g;
const ENVIRONMENT_REF_RE = /\$\{\{environment\.(.*?)\}\}/g;
const SELF_REF_RE = /\$\{\{(.*?)\}\}/g;

function substitute(value: string, re: RegExp, vars: Record<string, string>): string {
  return value.replace(re, (match, ref: string) => (Object.hasOwn(vars, ref) ? vars[ref] : match));
}

/** Mirrors Dokploy's prepareEnvironmentVariables: project, then environment, then service self-refs. Missing refs stay in place. */
export function resolveDokployRefs(
  entries: DokployEnvEntry[],
  sources: Pick<DokployEnvSources, "projectEnv" | "environmentEnv">,
): ResolveResult {
  const projectVars = parse(sources.projectEnv);
  const environmentVars = parse(sources.environmentEnv);
  const serviceVars: Record<string, string> = {};
  for (const { key, value } of entries) serviceVars[key] = value;

  const resolved: string[] = [];
  const out = entries.map(({ key, value }) => {
    let next = substitute(value, PROJECT_REF_RE, projectVars);
    next = substitute(next, ENVIRONMENT_REF_RE, environmentVars);
    next = substitute(next, SELF_REF_RE, serviceVars);
    if (next !== value && !resolved.includes(key)) resolved.push(key);
    return { key, value: next };
  });
  return { entries: out, resolved };
}

export interface ToVardoEnvOptions {
  /** Keep `$$` as is. Default false: Dokploy escapes `$` for compose, and Vardo escapes it on write. */
  keepDollars?: boolean;
}

/** Maps Dokploy entries to Vardo env-file content; the last duplicate wins. */
export function toVardoEnv(entries: DokployEnvEntry[], opts: ToVardoEnvOptions = {}): VardoEnvResult {
  const byKey = new Map<string, string>();
  for (const { key, value } of entries) byKey.set(key, value);

  const lines: string[] = [];
  const written: string[] = [];
  const skipped: string[] = [];
  const unresolved: string[] = [];
  const unescaped: string[] = [];

  for (const [key, raw] of byKey) {
    let value = raw;
    if (!KEY_RE.test(key)) {
      skipped.push(key);
      continue;
    }
    if (DOKPLOY_REF_RE.test(value)) unresolved.push(key);
    if (!opts.keepDollars && value.includes("$$")) {
      value = value.replace(DOUBLE_DOLLAR_RE, "$");
      unescaped.push(key);
    }
    lines.push(formatEnvVar(key, value));
    written.push(key);
  }

  return { content: lines.length ? `${lines.join("\n")}\n` : "", written, skipped, unresolved, unescaped };
}

export interface Source {
  kind: "application" | "compose";
  id: string;
}

export function parseSource(from: string): Source {
  const m = from.match(/^(application|compose):(.+)$/);
  if (!m) throw new Error('--from must be "application:<id>" or "compose:<id>"');
  return { kind: m[1] as Source["kind"], id: m[2] };
}

export interface Args {
  from?: string;
  app?: string;
  dryRun: boolean;
  overwrite: boolean;
  keepDollars: boolean;
  dokployUrl?: string;
  vardoUrl?: string;
  org?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, overwrite: false, keepDollars: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--overwrite") out.overwrite = true;
    else if (a === "--keep-dollars") out.keepDollars = true;
    else if (a === "--from") out.from = next();
    else if (a === "--app") out.app = next();
    else if (a === "--dokploy-url") out.dokployUrl = next();
    else if (a === "--vardo-url") out.vardoUrl = next();
    else if (a === "--org") out.org = next();
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

type Fetch = typeof fetch;

interface DokployProject {
  env?: string | null;
}

interface DokployEnvironment {
  env?: string | null;
  projectId?: string | null;
  project?: DokployProject | null;
}

interface DokployService {
  env?: string | null;
  environmentId?: string | null;
  environment?: DokployEnvironment | null;
  projectId?: string | null;
  project?: DokployProject | null;
}

async function dokployGet<T>(baseUrl: string, apiKey: string, procedure: string, query: Record<string, string>, fetchImpl: Fetch): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/${procedure}?${new URLSearchParams(query)}`;
  const res = await fetchImpl(url, { headers: { "x-api-key": apiKey, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Dokploy ${procedure} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Reads a service's env plus its owning project's and environment's env. */
export async function fetchDokployEnv(
  baseUrl: string,
  apiKey: string,
  source: Source,
  fetchImpl: Fetch = fetch,
): Promise<DokployEnvSources> {
  const param = source.kind === "application" ? "applicationId" : "composeId";
  const body = await dokployGet<DokployService>(baseUrl, apiKey, `${source.kind}.one`, { [param]: source.id }, fetchImpl);

  let environment = body.environment ?? null;
  if (!environment && body.environmentId) {
    environment = await dokployGet<DokployEnvironment>(baseUrl, apiKey, "environment.one", { environmentId: body.environmentId }, fetchImpl);
  }

  let project = environment?.project ?? body.project ?? null;
  const projectId = environment?.projectId ?? body.projectId;
  if (!project && projectId) {
    project = await dokployGet<DokployProject>(baseUrl, apiKey, "project.one", { projectId }, fetchImpl);
  }

  return { env: body.env ?? "", projectEnv: project?.env ?? "", environmentEnv: environment?.env ?? "" };
}

async function vardoJson(fetchImpl: Fetch, url: string, apiKey: string, init?: RequestInit) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Vardo ${init?.method ?? "GET"} ${new URL(url).pathname} failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** Finds a Vardo app by exact name. */
export async function findVardoApp(
  baseUrl: string,
  apiKey: string,
  orgId: string,
  name: string,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  for (let offset = 0; ; offset += 100) {
    const data = await vardoJson(
      fetchImpl,
      `${baseUrl}/api/v1/organizations/${orgId}/apps?limit=100&offset=${offset}`,
      apiKey,
    );
    const list = (data.apps as { id: string; name: string }[]) ?? [];
    const hit = list.find((a) => a.name === name);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  throw new Error(`No Vardo app named "${name}"`);
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  log: (line: string) => void;
}

/** Runs the import. Logs names only, never values. */
export async function run(args: Args, deps: RunDeps): Promise<void> {
  const { env, fetch: fetchImpl, log } = deps;
  if (!args.from || !args.app) throw new Error("--from and --app are required");
  const dokployKey = env.DOKPLOY_API_KEY;
  const dokployUrl = args.dokployUrl || env.DOKPLOY_URL;
  if (!dokployKey) throw new Error("Set DOKPLOY_API_KEY");
  if (!dokployUrl) throw new Error("Set DOKPLOY_URL or pass --dokploy-url");

  const sources = await fetchDokployEnv(dokployUrl, dokployKey, parseSource(args.from), fetchImpl);
  const { entries, resolved } = resolveDokployRefs(parseDokployEnv(sources.env), sources);
  const result = toVardoEnv(entries, { keepDollars: args.keepDollars });

  log(`${result.written.length} variable(s) from ${args.from}`);
  for (const name of result.written) log(`  ${name}`);
  if (resolved.length) {
    log(`Resolved Dokploy references: ${resolved.join(", ")}`);
  }
  if (result.unescaped.length) {
    log(`Turned $$ into $ (pass --keep-dollars to skip): ${result.unescaped.join(", ")}`);
  }
  if (result.unresolved.length) {
    log(`Unresolved Dokploy references (\${{...}}), set by hand: ${result.unresolved.join(", ")}`);
  }
  if (result.skipped.length) {
    log(`Skipped, names Vardo can't use: ${result.skipped.join(", ")}`);
  }

  if (args.dryRun) {
    log("Dry run: nothing written.");
    return;
  }

  const vardoKey = env.VARDO_API_KEY;
  if (!vardoKey) throw new Error("Set VARDO_API_KEY");
  const vardoUrl = (args.vardoUrl || env.VARDO_URL || "http://localhost:3000").replace(/\/$/, "");

  let orgId = args.org;
  if (!orgId) {
    const orgs = ((await vardoJson(fetchImpl, `${vardoUrl}/api/v1/organizations`, vardoKey)).organizations as { id: string }[]) ?? [];
    if (!orgs.length) throw new Error("No Vardo organizations for this token");
    orgId = orgs[0].id;
  }

  const appId = await findVardoApp(vardoUrl, vardoKey, orgId, args.app, fetchImpl);
  const envUrl = `${vardoUrl}/api/v1/organizations/${orgId}/apps/${appId}/env-vars`;

  if (!args.overwrite) {
    const existing = await vardoJson(fetchImpl, envUrl, vardoKey);
    if (typeof existing.content === "string" && existing.content.trim()) {
      throw new Error(`${args.app} already has an env; pass --overwrite to replace it`);
    }
  }

  await vardoJson(fetchImpl, envUrl, vardoKey, { method: "PUT", body: JSON.stringify({ content: result.content }) });
  log(`Wrote ${result.written.length} variable(s) to ${args.app}. Redeploy to apply.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.from || !args.app) {
    console.log("Usage: tsx scripts/dokploy-env-import.ts --from application:<id>|compose:<id> --app <name> [--dry-run] [--overwrite] [--keep-dollars]");
    process.exit(args.help ? 0 : 1);
  }
  await run(args, { env: process.env, fetch, log: (line) => console.log(line) });
}

const entry = process.argv[1] ?? "";
if (/dokploy-env-import\.[cm]?[jt]s$/.test(entry)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : "failed"}`);
    process.exit(1);
  });
}
