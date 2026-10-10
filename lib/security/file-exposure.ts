import { createHash, randomBytes } from "node:crypto";
import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { assertPublicDomain } from "./validate-domain";
import { safeFetch } from "./safe-fetch";
import { getDomainProbePolicy } from "./outbound-policy";
import type { OutboundPolicy } from "./ssrf";
import type { SecurityFinding } from "./types";

const log = logger.child("security");

/** What a probe saw: status, media type and the first MAX_BODY_BYTES of the body. */
type ProbeResponse = {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  text: string;
  length: number;
  hash: string;
};

type Probe = {
  path: string;
  severity: SecurityFinding["severity"];
  /** Set for files that are HTML when served, like phpinfo. */
  html?: boolean;
  /** The body must look like the real file. */
  match: (r: ProbeResponse) => boolean;
};

const DS_STORE_MAGIC = [0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31];

const sqlDump = (r: ProbeResponse) => /\b(INSERT INTO|CREATE TABLE)\b/.test(r.text);

const PROBES: Probe[] = [
  { path: "/.env", severity: "critical", match: (r) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/m.test(r.text) },
  { path: "/.git/config", severity: "critical", match: (r) => r.text.includes("[core]") },
  { path: "/.git/HEAD", severity: "critical", match: (r) => /^(ref: refs\/|[0-9a-f]{40}\s*$)/.test(r.text) },
  { path: "/wp-config.php", severity: "critical", match: (r) => /define\(\s*['"]DB_(NAME|PASSWORD)['"]/.test(r.text) },
  { path: "/server.key", severity: "critical", match: (r) => r.text.includes("-----BEGIN") },
  { path: "/.ssh/id_rsa", severity: "critical", match: (r) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(r.text) },
  { path: "/.htaccess", severity: "warning", match: (r) => /^\s*(RewriteEngine|RewriteRule|Deny from|Allow from|Require |Options )/im.test(r.text) },
  { path: "/.DS_Store", severity: "warning", match: (r) => DS_STORE_MAGIC.every((b, i) => r.bytes[i] === b) },
  { path: "/phpinfo.php", severity: "warning", html: true, match: (r) => r.text.includes("PHP Version") && /phpinfo|PHP License|Zend/i.test(r.text) },
  { path: "/server-status", severity: "warning", html: true, match: (r) => /Apache Server Status|Server Status for/.test(r.text) },
  { path: "/debug.log", severity: "warning", match: (r) => isText(r) && r.text.trim().length > 0 },
  { path: "/.svn/entries", severity: "warning", match: (r) => /^\d+\s*\n/.test(r.text) },
  { path: "/backup.sql", severity: "warning", match: sqlDump },
  { path: "/dump.sql", severity: "warning", match: sqlDump },
  { path: "/.npmrc", severity: "warning", match: (r) => /^\s*(registry\s*=|_auth|\/\/[^\s]+:_authToken\s*=)/m.test(r.text) },
  { path: "/.docker/config.json", severity: "warning", match: (r) => /^\s*\{/.test(r.text) && r.text.includes("\"auths\"") },
  { path: "/config.yml", severity: "warning", match: (r) => !/^\s*[{[]/.test(r.text) && /^[\w-]+\s*:/m.test(r.text) },
];

const TIMEOUT_MS = 3_000;
const CONCURRENCY = 5;
const MAX_BODY_BYTES = 8 * 1024;

function isText(r: ProbeResponse): boolean {
  return !r.bytes.includes(0);
}

function isHtml(r: ProbeResponse): boolean {
  return /\b(text\/html|application\/xhtml\+xml)\b/.test(r.contentType)
    || /^\s*<(!doctype html|html|head|body)\b/i.test(r.text);
}

/** Same status and media type, and the same body or one within a few percent in length. */
function matchesBaseline(r: ProbeResponse, baseline: ProbeResponse): boolean {
  if (r.status !== baseline.status || r.contentType !== baseline.contentType) return false;
  if (r.hash === baseline.hash) return true;
  const tolerance = Math.max(64, Math.max(r.length, baseline.length) * 0.05);
  return Math.abs(r.length - baseline.length) <= tolerance;
}

/** True when the response is the real file rather than a catch-all page. */
function isExposed(probe: Probe, r: ProbeResponse, baselines: ProbeResponse[]): boolean {
  if (r.status < 200 || r.status > 299) return false;
  if (r.bytes.length === 0) return false;
  if (!probe.html && isHtml(r)) return false;
  if (baselines.some((b) => matchesBaseline(r, b))) return false;
  return probe.match(r);
}

async function readPrefix(res: Response, controller: AbortController): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (size >= MAX_BODY_BYTES) {
      // Stop the download once the prefix is in.
      reader.cancel().catch(() => {});
      controller.abort();
    }
  }
  const out = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

async function fetchProbe(url: string, policy: OutboundPolicy): Promise<ProbeResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // A redirect throws here, which counts as not exposed.
    const res = await safeFetch(url, { method: "GET", maxRedirects: 0, signal: controller.signal, policy });
    const bytes = await readPrefix(res, controller);
    const declared = Number(res.headers.get("content-length"));
    return {
      status: res.status,
      contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
      bytes,
      text: new TextDecoder().decode(bytes),
      length: Number.isFinite(declared) && declared > 0 ? declared : bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probes a deployed domain for commonly exposed sensitive files. */
export async function checkFileExposure(domain: string): Promise<SecurityFinding[]> {
  await assertPublicDomain(domain);

  const limit = pLimit(CONCURRENCY);
  const policy = await getDomainProbePolicy();
  const origin = `https://${domain}`;

  // Nonexistent paths show what the app's catch-all looks like.
  const nonce = randomBytes(8).toString("hex");
  const baselines = (await Promise.all([
    fetchProbe(`${origin}/vardo-probe-${nonce}`, policy),
    fetchProbe(`${origin}/.vardo-probe-${nonce}`, policy),
  ])).filter((b): b is ProbeResponse => b !== null);

  const findings: SecurityFinding[] = [];
  await Promise.all(
    PROBES.map((probe) =>
      limit(async () => {
        const res = await fetchProbe(`${origin}${probe.path}`, policy);
        if (!res || !isExposed(probe, res, baselines)) return;

        log.warn(`Exposed file detected: ${origin}${probe.path}`);
        findings.push({
          type: "file-exposure",
          severity: probe.severity,
          title: `Sensitive file exposed: ${probe.path}`,
          description: `The file at ${probe.path} is publicly accessible. This may expose credentials or server internals.`,
          detail: probe.path,
        });
      }),
    ),
  );

  return findings;
}
