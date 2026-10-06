// ---------------------------------------------------------------------------
// A non-default environment's own env file.
//
// The default environment reads apps.env_content. Every other environment
// reads environment_env, snapshotted from the app's env when it is created.
// ---------------------------------------------------------------------------

import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { isSecretKey } from "./is-secret-key";
import { parseEnvToMap } from "./parse-env";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace whole hostnames only, longest first, so `api.x.me` never rewrites inside `myapi.x.me`. */
export function rewriteHosts(content: string, replacements: Map<string, string>): string {
  const hosts = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (hosts.length === 0) return content;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9.-])(${hosts.map(escapeRegExp).join("|")})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
    "g",
  );
  return content.replace(pattern, (host) => replacements.get(host) ?? host);
}

/** Blank the value of every secret-looking key, keeping the key so it shows in the editor. */
export function blankSecrets(content: string): { content: string; blanked: string[] } {
  const blanked: string[] = [];
  const lines = content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = line.indexOf("=");
    if (eq <= 0) return line;
    const key = line.slice(0, eq).trim();
    if (!isSecretKey(key)) return line;
    blanked.push(key);
    return `${line.slice(0, eq)}=`;
  });
  return { content: lines.join("\n"), blanked };
}

export type EnvSnapshot = {
  /** Encrypted under the org's key, ready for environment_env.env_content. */
  envContent: string;
  varCount: number;
  blanked: string[];
};

/**
 * Snapshot an app's env for a new environment: rewrite production hostnames
 * and, for the `empty` clone strategy, blank secrets.
 */
export function snapshotEnv(opts: {
  appEnvContent: string | null;
  organizationId: string;
  hostReplacements?: Map<string, string>;
  strategy?: string | null;
}): EnvSnapshot {
  let content = "";
  if (opts.appEnvContent) {
    const { content: plain, decryptFailed } = decryptOrFallback(opts.appEnvContent, opts.organizationId);
    if (decryptFailed) {
      throw new Error("Could not decrypt the app's environment variables — check ENCRYPTION_MASTER_KEY");
    }
    content = plain;
  }
  content = rewriteHosts(content, opts.hostReplacements ?? new Map());
  let blanked: string[] = [];
  if (opts.strategy === "empty") ({ content, blanked } = blankSecrets(content));
  return {
    envContent: encrypt(content, opts.organizationId),
    varCount: Object.keys(parseEnvToMap(content)).length,
    blanked,
  };
}

/** Literal production hostnames an environment's env still points at, as `KEY → host` pairs. */
export function productionHostRefs(
  env: Record<string, string>,
  productionHosts: string[],
): { key: string; host: string }[] {
  const found: { key: string; host: string }[] = [];
  for (const host of productionHosts) {
    if (!host) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9.-])${escapeRegExp(host)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`);
    for (const [key, value] of Object.entries(env)) {
      if (pattern.test(value)) found.push({ key, host });
    }
  }
  return found;
}
