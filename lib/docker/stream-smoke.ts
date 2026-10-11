// After a self-deploy: opens the new console's live stats streams and waits for a data event on each.

import { randomBytes } from "crypto";
import { nanoid } from "nanoid";
import { asc, eq } from "drizzle-orm";

export const STREAM_SMOKE_TIMEOUT_MS = 20_000;
/** Lifetime of the read-only token the check signs in with. */
const TOKEN_TTL_MS = 2 * 60_000;
const TOKEN_NAME = "Post-deploy stream check";

export type StreamCheck = {
  name: string;
  path: string;
  /** The event that carries data. */
  event: string;
};

export type StreamResult =
  | { name: string; ok: true; waitedMs: number }
  | { name: string; ok: false; reason: string };

/** Streams fed by in-process state that a loop moving to the worker can strand. */
export function streamChecks(target: { orgId: string; appId: string; projectId: string }): StreamCheck[] {
  const org = `/api/v1/organizations/${encodeURIComponent(target.orgId)}`;
  return [
    { name: "org stats", path: `${org}/stats/stream`, event: "point" },
    { name: "project stats", path: `${org}/projects/${encodeURIComponent(target.projectId)}/stats/stream`, event: "point" },
    { name: "app stats", path: `${org}/apps/${encodeURIComponent(target.appId)}/stats/stream`, event: "point" },
  ];
}

/** Events a stream sends when it ends without data. */
const ENDING_EVENTS = new Set(["error", "timeout", "shutdown"]);

type Frame = { event: string; data: string };

/** Frames complete in `buffer`, and what's left over. */
export function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: Frame[] = [];
  for (const part of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

/** Reads `body` until a frame named `event` arrives. */
export async function firstEvent(
  body: ReadableStream<Uint8Array>,
  event: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next === "timeout") return { ok: false, reason: `no ${event} event in ${Math.round(timeoutMs / 1000)}s` };
      if (next.done) return { ok: false, reason: "stream closed before any data" };
      buffer += decoder.decode(next.value, { stream: true });
      const parsed = parseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.event === event) return { ok: true };
        if (ENDING_EVENTS.has(frame.event)) return { ok: false, reason: `stream sent ${frame.event}: ${frame.data}` };
      }
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

/** Opens one stream with `token` and waits for its data event. */
export async function checkStream(
  baseUrl: string,
  check: StreamCheck,
  token: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<StreamResult> {
  const timeoutMs = opts.timeoutMs ?? STREAM_SMOKE_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const started = Date.now();
  const connectTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${baseUrl}${check.path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    // The routes answer 204 when this process has no metrics provider.
    if (res.status === 204) return { name: check.name, ok: false, reason: "204: no metrics provider in the console" };
    if (!res.ok || !res.body) return { name: check.name, ok: false, reason: `HTTP ${res.status}` };
    const result = await firstEvent(res.body, check.event, Math.max(1, timeoutMs - (Date.now() - started)));
    return result.ok
      ? { name: check.name, ok: true, waitedMs: Date.now() - started }
      : { name: check.name, ok: false, reason: result.reason };
  } catch (err) {
    const reason = controller.signal.aborted ? `no response in ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
    return { name: check.name, ok: false, reason };
  } finally {
    clearTimeout(connectTimer);
    controller.abort();
  }
}

/** A short-lived read-only token for a member of `orgId`, removed by `revoke`. Null when no member can hold one. */
export async function mintSmokeToken(orgId: string): Promise<{ token: string; revoke: () => Promise<void> } | null> {
  const { db } = await import("@/lib/db");
  const { apiTokens, memberships, organizations } = await import("@/lib/db/schema");
  const { hashApiToken } = await import("@/lib/auth/api-token");
  const { isInstanceAdminUser } = await import("@/lib/auth/system-org");

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { isSystemManaged: true },
  });
  if (!org) return null;
  const members = await db.query.memberships.findMany({
    where: eq(memberships.organizationId, orgId),
    columns: { userId: true },
    orderBy: [asc(memberships.createdAt)],
  });
  let userId: string | null = null;
  for (const m of members) {
    // System-org memberships count only for instance admins.
    if (!org.isSystemManaged || (await isInstanceAdminUser(m.userId))) {
      userId = m.userId;
      break;
    }
  }
  if (!userId) return null;

  const token = `vardo_${randomBytes(32).toString("hex")}`;
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    userId,
    organizationId: orgId,
    name: TOKEN_NAME,
    tokenHash: hashApiToken(token),
    scope: "custom",
    capabilities: ["org.view", "app.view"],
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return {
    token,
    revoke: async () => {
      await db.delete(apiTokens).where(eq(apiTokens.id, id));
    },
  };
}

export type SmokeOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "ran"; results: StreamResult[] };

type SmokeDeps = {
  metricsOn: () => Promise<boolean>;
  tokensOn: () => Promise<boolean>;
  mint: typeof mintSmokeToken;
  check: typeof checkStream;
};

const defaultDeps: SmokeDeps = {
  metricsOn: async () => (await import("@/lib/config/features")).isFeatureEnabledAsync("metrics"),
  tokensOn: async () => (await import("@/lib/config/features")).isFeatureEnabledAsync("api-tokens"),
  mint: mintSmokeToken,
  check: checkStream,
};

/** Runs every stream check against the console at `baseUrl`. */
export async function smokeStreams(
  baseUrl: string,
  target: { orgId: string; appId: string; projectId: string },
  opts: { timeoutMs?: number; deps?: Partial<SmokeDeps> } = {},
): Promise<SmokeOutcome> {
  const deps = { ...defaultDeps, ...opts.deps };
  if (!(await deps.metricsOn())) return { kind: "skipped", reason: "metrics are off" };
  if (!(await deps.tokensOn())) return { kind: "skipped", reason: "API tokens are off" };
  const minted = await deps.mint(target.orgId);
  if (!minted) return { kind: "skipped", reason: "no member of the org to sign in as" };
  try {
    const results = await Promise.all(
      streamChecks(target).map((check) => deps.check(baseUrl, check, minted.token, { timeoutMs: opts.timeoutMs })),
    );
    return { kind: "ran", results };
  } finally {
    await minted.revoke().catch(() => {});
  }
}

/** Log lines for an outcome, and the unfinished-work reason when a stream sent nothing. */
export function describeSmoke(outcome: SmokeOutcome, slot: string): { lines: string[]; failure: string | null } {
  if (outcome.kind === "skipped") return { lines: [`[smoke] Live stats streams not checked: ${outcome.reason}`], failure: null };
  const lines = outcome.results.map((r) =>
    r.ok ? `[smoke] ${r.name} stream sent data after ${(r.waitedMs / 1000).toFixed(1)}s` : `[smoke] ${r.name} stream: ${r.reason}`,
  );
  const failed = outcome.results.filter((r): r is Extract<StreamResult, { ok: false }> => !r.ok);
  const failure = failed.length
    ? `the live stats on ${slot} sent no data (${failed.map((r) => `${r.name}: ${r.reason}`).join("; ")})`
    : null;
  return { lines, failure };
}
