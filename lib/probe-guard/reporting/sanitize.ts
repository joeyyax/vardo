// Paths safe to publish in an abuse report: no query, no host, address, email, token or name of anything here.

import { isIP } from "net";

const MAX_SEGMENT = 40;
const MAX_PATH = 100;
export const REDACTED = "*";

// File suffixes a probed name may carry. Ones that are also TLDs (.zip, .sh, .py, .pl, .dev, .app) are left out.
const FILE_SUFFIXES = new Set([
  "php", "php5", "php7", "phtml", "env", "json", "sql", "gz", "bz2", "tgz", "tar", "rar", "7z", "bak", "old", "orig",
  "swp", "swo", "tmp", "dist", "txt", "ini", "xml", "yml", "yaml", "toml", "log", "conf", "cfg", "config", "js", "mjs",
  "html", "htm", "asp", "aspx", "jsp", "cgi", "pem", "key", "ppk", "pub", "db", "sqlite", "sqlite3", "mdb", "local",
  "production", "staging", "example", "sample", "backup", "bkp", "git", "svn", "htaccess", "htpasswd", "ds_store",
  "passwd", "shadow", "environ", "credentials",
]);

/** Lowercase terms that must never appear: hosts, their labels and the names of apps, projects and orgs. */
export function sensitiveTerms(input: { hosts?: readonly (string | null | undefined)[]; names?: readonly (string | null | undefined)[] }): string[] {
  const terms = new Set<string>();
  for (const raw of input.hosts ?? []) {
    const host = raw?.trim().toLowerCase().replace(/^\*\./, "").replace(/:\d+$/, "");
    if (!host) continue;
    terms.add(host);
    const labels = host.split(".").filter(Boolean);
    for (let i = 1; i < labels.length - 1; i++) terms.add(labels.slice(i).join("."));
    // Every label but the TLD: scanners try <name>.zip and <name>.sql.
    for (const label of labels.slice(0, -1)) if (label.length >= 3) terms.add(label);
  }
  for (const raw of input.names ?? []) {
    const name = raw?.trim().toLowerCase();
    if (!name) continue;
    if (name.length >= 3) terms.add(name);
    for (const word of name.split(/[^a-z0-9]+/)) if (word.length >= 4) terms.add(word);
  }
  return [...terms];
}

function looksLikeToken(segment: string): boolean {
  const alnum = segment.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length >= 16 && /\d/.test(alnum) && /[A-Za-z]/.test(alnum)) return true;
  return /[A-Za-z0-9]{20,}/.test(segment);
}

/** Whether one path segment is safe to publish as is. */
export function safeSegment(segment: string, terms: readonly string[] = []): boolean {
  if (segment === "" || segment === "." || segment === "..") return true;
  if (segment.length > MAX_SEGMENT) return false;
  if (!/^[A-Za-z0-9._~-]+$/.test(segment)) return false;
  if (isIP(segment)) return false;
  if (looksLikeToken(segment)) return false;
  const lower = segment.toLowerCase();
  if (terms.some((t) => lower.includes(t))) return false;
  const parts = lower.replace(/^\.+/, "").split(".");
  if (parts.some((p) => p === "")) return false;
  // Anything dotted must read as name plus file suffixes, never as a hostname.
  return parts.slice(1).every((p) => FILE_SUFFIXES.has(p));
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A path with its query and fragment dropped and every unsafe segment replaced by `*`. */
export function sanitizeReportPath(raw: string, terms: readonly string[] = []): string {
  let path = raw.split(/[?#]/)[0];
  path = decodeOnce(path).split(/[?#]/)[0];
  // A full URL keeps only its path.
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const segments = path.split("/").map((s) => (safeSegment(s, terms) ? s : REDACTED));
  let out = segments.join("/").replace(/\*(?:\/\*)+/g, REDACTED);
  if (!out.startsWith("/")) out = `/${out}`;
  return out.length > MAX_PATH ? `${out.slice(0, MAX_PATH - 1)}…` : out;
}
