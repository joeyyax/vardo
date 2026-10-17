// Check runners. Each takes a target and returns a CheckResult; the clock, fetch and sockets are injectable.

import net from "node:net";
import tls from "node:tls";
import type { CheckResult, ErrorKind, HttpCheck, TcpCheck, TlsCheck } from "./types";

export type RunContext = {
  monitorId: string;
  vantageId: string;
  now?: () => number;
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
  if (e.code && CODE_KINDS[e.code]) return CODE_KINDS[e.code];
  if (e.code?.startsWith("ERR_SSL") || e.code?.startsWith("ERR_TLS") || e.code?.includes("CERT")) return "tls";
  if (e.cause && e.cause !== err) return classifyError(e.cause);
  return "unknown";
}

function result(ctx: RunContext, at: number, end: number, rest: Partial<CheckResult> & { ok: boolean }): CheckResult {
  return { monitorId: ctx.monitorId, vantageId: ctx.vantageId, at, latencyMs: Math.max(0, Math.round(end - at)), ...rest };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

export async function runHttpCheck(check: HttpCheck, ctx: HttpContext): Promise<CheckResult> {
  const now = ctx.now ?? Date.now;
  const doFetch = ctx.fetch ?? fetch;
  const at = now();
  try {
    const res = await doFetch(check.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(check.timeoutMs),
      headers: { "user-agent": "Vardo-Uptime/1" },
    });
    const status = res.status;
    if (status < check.expectedStatus.min || status > check.expectedStatus.max) {
      await res.body?.cancel().catch(() => {});
      return result(ctx, at, now(), { ok: false, status, error: "status" });
    }
    if (check.keyword) {
      const body = await readCapped(res);
      if (!body.includes(check.keyword)) return result(ctx, at, now(), { ok: false, status, error: "keyword" });
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return result(ctx, at, now(), { ok: true, status });
  } catch (err) {
    return result(ctx, at, now(), { ok: false, error: classifyError(err) });
  }
}

export function runTcpCheck(check: TcpCheck, ctx: TcpContext): Promise<CheckResult> {
  const now = ctx.now ?? Date.now;
  const connect = ctx.connect ?? net.connect;
  const at = now();
  return new Promise((resolve) => {
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
  });
}

export function runTlsCheck(check: TlsCheck, ctx: TlsContext): Promise<CheckResult> {
  const now = ctx.now ?? Date.now;
  const connect = ctx.connect ?? tls.connect;
  const at = now();
  return new Promise((resolve) => {
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
  });
}

/** Runs whichever check the monitor carries. */
export function runCheck(
  monitor: { id: string; check: HttpCheck | TcpCheck | TlsCheck },
  vantageId: string,
  deps: { now?: () => number; fetch?: typeof fetch; netConnect?: typeof net.connect; tlsConnect?: typeof tls.connect } = {},
): Promise<CheckResult> {
  const base = { monitorId: monitor.id, vantageId, now: deps.now };
  switch (monitor.check.type) {
    case "http":
      return runHttpCheck(monitor.check, { ...base, fetch: deps.fetch });
    case "tcp":
      return runTcpCheck(monitor.check, { ...base, connect: deps.netConnect });
    case "tls":
      return runTlsCheck(monitor.check, { ...base, connect: deps.tlsConnect });
  }
}
