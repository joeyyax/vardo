// Check runners. Each takes a target and returns a CheckResult; the clock, fetch and sockets are injectable.

import net from "node:net";
import tls from "node:tls";
import { sendableHeaders } from "./headers";
import { cacheOf, isNoRoute } from "./response";
import type { CheckPath, CheckResult, ErrorKind, HttpCheck, TcpCheck, TlsCheck } from "./types";

/** Resolves to a reason when the host must not be connected to, else null. */
export type HostGuard = (host: string) => Promise<string | null>;

export type RunContext = {
  monitorId: string;
  vantageId: string;
  path: CheckPath;
  now?: () => number;
  /** Checked before a TCP or TLS connection; HTTP guards itself through the injected fetch. */
  guard?: HostGuard;
};

export type HttpContext = RunContext & { fetch?: typeof fetch };
export type TcpContext = RunContext & { connect?: typeof net.connect };
export type TlsContext = RunContext & { connect?: typeof tls.connect };

const MAX_BODY_BYTES = 1_000_000;
const DAY_MS = 86_400_000;

const CODE_KINDS: Record<string, ErrorKind> = {
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  EAI_NODATA: "dns",
  ECONNREFUSED: "refused",
  ECONNRESET: "reset",
  EPIPE: "reset",
  ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  CERT_HAS_EXPIRED: "cert-expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  SELF_SIGNED_CERT_IN_CHAIN: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  ERR_SSL_WRONG_VERSION_NUMBER: "tls",
};

/** Maps a thrown error to a kind. Follows `cause`. */
export function classifyError(err: unknown): ErrorKind {
  if (!err || typeof err !== "object") return "unknown";
  const e = err as { name?: string; code?: string; cause?: unknown };
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  if (e.name === "BlockedUrlError") return "blocked";
  if (e.code && CODE_KINDS[e.code]) return CODE_KINDS[e.code];
  if (e.code?.startsWith("ERR_SSL") || e.code?.startsWith("ERR_TLS") || e.code?.includes("CERT")) return "tls";
  if (e.cause && e.cause !== err) return classifyError(e.cause);
  return "unknown";
}

function result(ctx: RunContext, at: number, end: number, rest: Partial<CheckResult> & { ok: boolean }): CheckResult {
  return { monitorId: ctx.monitorId, vantageId: ctx.vantageId, path: ctx.path, at, latencyMs: Math.max(0, Math.round(end - at)), ...rest };
}

/** Bytes read to size a response without a Content-Length: enough to tell a heavy page from a light one. */
export const SIZE_READ_BYTES = 65_536;

/** Reads up to `cap` bytes, decoding text only when asked. Returns the text and the bytes read. */
async function readCapped(res: Response, cap: number, decode: boolean): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (bytes < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (decode) text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return { text, bytes };
}

/** Content-Length when the response sends one, else the bytes read. */
function sizeOf(res: Response, read: number): number {
  const declared = Number(res.headers.get("content-length"));
  return Number.isInteger(declared) && declared >= 0 && res.headers.get("content-length")?.trim() !== "" ? Math.max(declared, read) : read;
}

export async function runHttpCheck(check: HttpCheck, ctx: HttpContext): Promise<CheckResult> {
  const now = ctx.now ?? Date.now;
  const doFetch = ctx.fetch ?? fetch;
  const at = now();
  try {
    const res = await doFetch(check.url, {
      method: check.method ?? "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(check.timeoutMs),
      headers: { ...sendableHeaders(check.headers), "user-agent": "Vardo-Uptime/1", "cache-control": "no-cache" },
    });
    const status = res.status;
    const cache = cacheOf(res.headers);
    const seen = cache ? { status, cache } : { status };
    // Vardo's catch-all answered: the host has no route, whatever the status says.
    if (isNoRoute(res.headers)) {
      await res.body?.cancel().catch(() => {});
      return result(ctx, at, now(), { ok: false, ...seen, error: "no-route" });
    }
    if (status < check.expectedStatus.min || status > check.expectedStatus.max) {
      await res.body?.cancel().catch(() => {});
      return result(ctx, at, now(), { ok: false, ...seen, error: "status" });
    }
    const body = await readCapped(res, check.keyword ? MAX_BODY_BYTES : SIZE_READ_BYTES, !!check.keyword);
    const bytes = sizeOf(res, body.bytes);
    if (check.keyword && !body.text.includes(check.keyword)) return result(ctx, at, now(), { ok: false, ...seen, bytes, error: "keyword" });
    return result(ctx, at, now(), { ok: true, ...seen, bytes });
  } catch (err) {
    return result(ctx, at, now(), { ok: false, error: classifyError(err) });
  }
}

export function runTcpCheck(check: TcpCheck, ctx: TcpContext): Promise<CheckResult> {
  const now = ctx.now ?? Date.now;
  const connect = ctx.connect ?? net.connect;
  const at = now();
  return guarded(ctx, check.host, at, now, () => new Promise((resolve) => {
    let settled = false;
    const done = (rest: Partial<CheckResult> & { ok: boolean }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result(ctx, at, now(), rest));
    };
    const socket = connect({ host: check.host, port: check.port });
    socket.setTimeout(check.timeoutMs ?? 10_000);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, error: "timeout" }));
    socket.once("error", (err) => done({ ok: false, error: classifyError(err) }));
  }));
}

export function runTlsCheck(check: TlsCheck, ctx: TlsContext): Promise<CheckResult> {
  const now = ctx.now ?? Date.now;
  const connect = ctx.connect ?? tls.connect;
  const at = now();
  return guarded(ctx, check.host, at, now, () => new Promise((resolve) => {
    let settled = false;
    const done = (rest: Partial<CheckResult> & { ok: boolean }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result(ctx, at, now(), rest));
    };
    const socket = connect({ host: check.host, port: check.port, servername: check.host });
    socket.setTimeout(check.timeoutMs ?? 10_000);
    socket.once("secureConnect", () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      const expires = validTo ? Date.parse(validTo) : NaN;
      if (Number.isNaN(expires)) return done({ ok: false, error: "tls" });
      const certDaysLeft = Math.floor((expires - now()) / DAY_MS);
      if (certDaysLeft < 0) return done({ ok: false, error: "cert-expired", certDaysLeft });
      if (certDaysLeft < check.warnDays) return done({ ok: false, error: "cert-expiring", certDaysLeft });
      done({ ok: true, certDaysLeft });
    });
    socket.once("timeout", () => done({ ok: false, error: "timeout" }));
    socket.once("error", (err) => done({ ok: false, error: classifyError(err) }));
  }));
}

/** Runs `run` unless the guard refuses the host; a refusal is a "blocked" result. */
async function guarded(ctx: RunContext, host: string, at: number, now: () => number, run: () => Promise<CheckResult>): Promise<CheckResult> {
  if (ctx.guard) {
    try {
      if (await ctx.guard(host)) return result(ctx, at, now(), { ok: false, error: "blocked" });
    } catch {
      return result(ctx, at, now(), { ok: false, error: "blocked" });
    }
  }
  return run();
}

/** Runs whichever check the monitor carries. */
/** Errors worth one quick retry: a dropped DNS packet or connection says little about the target. */
const RETRYABLE: ErrorKind[] = ["dns", "reset"];
export const RETRY_DELAY_MS = 1000;

type CheckDeps = { now?: () => number; fetch?: typeof fetch; netConnect?: typeof net.connect; tlsConnect?: typeof tls.connect; guard?: HostGuard; sleep?: (ms: number) => Promise<void> };

export async function runCheck(
  monitor: { id: string; check: HttpCheck | TcpCheck | TlsCheck },
  vantageId: string,
  path: CheckPath,
  deps: CheckDeps = {},
): Promise<CheckResult> {
  const first = await runOnce(monitor, vantageId, path, deps);
  if (first.ok || !first.error || !RETRYABLE.includes(first.error)) return first;
  await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(RETRY_DELAY_MS);
  return runOnce(monitor, vantageId, path, deps);
}

function runOnce(
  monitor: { id: string; check: HttpCheck | TcpCheck | TlsCheck },
  vantageId: string,
  path: CheckPath,
  deps: CheckDeps,
): Promise<CheckResult> {
  const base = { monitorId: monitor.id, vantageId, path, now: deps.now, guard: deps.guard };
  switch (monitor.check.type) {
    case "http":
      return runHttpCheck(monitor.check, { ...base, fetch: deps.fetch });
    case "tcp":
      return runTcpCheck(monitor.check, { ...base, connect: deps.netConnect });
    case "tls":
      return runTlsCheck(monitor.check, { ...base, connect: deps.tlsConnect });
  }
}
