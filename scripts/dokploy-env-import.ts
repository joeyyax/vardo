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
 *   --dokploy-url     Dokploy base URL. Default: DOKPLOY_URL.
 *   --vardo-url       Vardo base URL. Default: VARDO_URL or http://localhost:3000.
 *   --org             Vardo organization ID. Default: the first one the token belongs to.
 *
 * Environment:
 *   DOKPLOY_API_KEY   Dokploy API key (required).
 *   VARDO_API_KEY     Vardo API token (required unless --dry-run).
 *
 * Vardo encrypts the env when its env-vars endpoint saves it.
 */

export interface DokployEnvEntry {
  key: string;
  value: string;
}

export interface VardoEnvResult {
  content: string;
  /** Names written. */
  written: string[];
  /** Names Vardo's env format can't hold (multi-line values). */
  skipped: string[];
  /** Names whose value references a Dokploy shared variable (`${{...}}`), which Vardo won't resolve. */
  unresolved: string[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOKPLOY_REF_RE = /\$\{\{[^}]*\}\}/;

/** Parses Dokploy's env text. Quoted values may span lines; unquoted values are literal. */
export function parseDokployEnv(text: string): DokployEnvEntry[] {
  const entries: DokployEnvEntry[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!KEY_RE.test(key)) continue;

    let value = lines[i].slice(lines[i].indexOf("=") + 1).replace(/^\s+/, "");
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let body = value.slice(1);
      let closed = body.trimEnd().endsWith(quote);
      let j = i;
      while (!closed && j + 1 < lines.length) {
        j++;
        body += `\n${lines[j]}`;
        closed = lines[j].trimEnd().endsWith(quote);
      }
      if (closed) {
        value = body.trimEnd().slice(0, -1);
        i = j;
      } else {
        value = value.trimEnd();
      }
    } else {
      value = value.trimEnd();
    }
    entries.push({ key, value });
  }

  return entries;
}

/** Vardo's env parser is line-based and strips one pair of outer quotes, so quote values that would not survive it. */
function formatValue(value: string): string {
  const edgeQuote = /^["']/.test(value) && /["']$/.test(value);
  const padded = value !== value.trim();
  return edgeQuote || padded ? `"${value}"` : value;
}

/** Maps Dokploy entries to Vardo env-file content; the last duplicate wins. */
export function toVardoEnv(entries: DokployEnvEntry[]): VardoEnvResult {
  const byKey = new Map<string, string>();
  for (const { key, value } of entries) byKey.set(key, value);

  const lines: string[] = [];
  const written: string[] = [];
  const skipped: string[] = [];
  const unresolved: string[] = [];

  for (const [key, value] of byKey) {
    if (value.includes("\n")) {
      skipped.push(key);
      continue;
    }
    if (DOKPLOY_REF_RE.test(value)) unresolved.push(key);
    lines.push(`${key}=${formatValue(value)}`);
    written.push(key);
  }

  return { content: lines.length ? `${lines.join("\n")}\n` : "", written, skipped, unresolved };
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
  dokployUrl?: string;
  vardoUrl?: string;
  org?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, overwrite: false, help: false };
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

/** Reads the env text for an application or compose. */
export async function fetchDokployEnv(
  baseUrl: string,
  apiKey: string,
  source: Source,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const param = source.kind === "application" ? "applicationId" : "composeId";
  const url = `${baseUrl.replace(/\/$/, "")}/api/${source.kind}.one?${param}=${encodeURIComponent(source.id)}`;
  const res = await fetchImpl(url, { headers: { "x-api-key": apiKey, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Dokploy ${source.kind}.one failed: ${res.status}`);
  const body = (await res.json()) as { env?: string | null };
  return body.env ?? "";
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.from || !args.app) {
    console.log("Usage: tsx scripts/dokploy-env-import.ts --from application:<id>|compose:<id> --app <name> [--dry-run] [--overwrite]");
    process.exit(args.help ? 0 : 1);
  }

  const dokployKey = process.env.DOKPLOY_API_KEY;
  const dokployUrl = args.dokployUrl || process.env.DOKPLOY_URL;
  if (!dokployKey) throw new Error("Set DOKPLOY_API_KEY");
  if (!dokployUrl) throw new Error("Set DOKPLOY_URL or pass --dokploy-url");

  const text = await fetchDokployEnv(dokployUrl, dokployKey, parseSource(args.from));
  const result = toVardoEnv(parseDokployEnv(text));

  console.log(`${result.written.length} variable(s) from ${args.from}`);
  for (const name of result.written) console.log(`  ${name}`);
  if (result.unresolved.length) {
    console.log(`Reference a Dokploy shared variable (\${{...}}), set by hand: ${result.unresolved.join(", ")}`);
  }
  if (result.skipped.length) {
    console.log(`Skipped, multi-line values Vardo's env format can't hold: ${result.skipped.join(", ")}`);
  }

  if (args.dryRun) {
    console.log("Dry run: nothing written.");
    return;
  }

  const vardoKey = process.env.VARDO_API_KEY;
  if (!vardoKey) throw new Error("Set VARDO_API_KEY");
  const vardoUrl = (args.vardoUrl || process.env.VARDO_URL || "http://localhost:3000").replace(/\/$/, "");

  let orgId = args.org;
  if (!orgId) {
    const orgs = ((await vardoJson(fetch, `${vardoUrl}/api/v1/organizations`, vardoKey)).organizations as { id: string }[]) ?? [];
    if (!orgs.length) throw new Error("No Vardo organizations for this token");
    orgId = orgs[0].id;
  }

  const appId = await findVardoApp(vardoUrl, vardoKey, orgId, args.app);
  const envUrl = `${vardoUrl}/api/v1/organizations/${orgId}/apps/${appId}/env-vars`;

  if (!args.overwrite) {
    const existing = await vardoJson(fetch, envUrl, vardoKey);
    if (typeof existing.content === "string" && existing.content.trim()) {
      throw new Error(`${args.app} already has an env; pass --overwrite to replace it`);
    }
  }

  await vardoJson(fetch, envUrl, vardoKey, { method: "PUT", body: JSON.stringify({ content: result.content }) });
  console.log(`Wrote ${result.written.length} variable(s) to ${args.app}. Redeploy to apply.`);
}

const entry = process.argv[1] ?? "";
if (/dokploy-env-import\.[cm]?[jt]s$/.test(entry)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : "failed"}`);
    process.exit(1);
  });
}
