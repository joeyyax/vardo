// Health endpoint detection for automatic monitors, and the operator's answer when the best a monitor gets is a non-2xx below 500.

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, uptimeMonitors, type UptimeMonitorRow } from "@/lib/db/schema";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";
import { logger } from "@/lib/logger";
import {
  AUTO_EXPECTED_STATUS,
  DAY_MS,
  HASH_BODY_BYTES,
  HEALTH_PATHS,
  HTTP_METHODS,
  cacheOf,
  hashBody,
  imageHealthPaths,
  isNoRoute,
  judgeHomepage,
  parseHealthcheckPath,
  qualifiesAsHealth,
  qualifiesAsImageHealth,
  type HealthSource,
  type HttpCheck,
  type HttpMethod,
  type ImageHealthPath,
  type ReviewAnswer,
  type Sample,
} from "./core";
import { appNotRunning, autoCheckFor, autoIntervalFor, baseUrlOf, runStateColumns, withAutoFields } from "./auto";
import { UptimeInputError } from "./errors";
import { checkDeps, levelOf, targetRefusal, type PolicyLevel } from "./outbound";
import { applyHeaderPatch, openHeaders, type HeaderPatch } from "./secrets";
import { ownedRow } from "./service";
import type { ContainerHealth, DetectedHealth, ReviewItem, Scope } from "./types";

const log = logger.child("uptime-health");

/** Gap between detection requests from this instance: about three a second. */
export const PROBE_GAP_MS = 350;
/** Tests shorten the gap. */
export const probeSpacing = { gapMs: PROBE_GAP_MS };
const PROBE_TIMEOUT_MS = 8000;
/** Detection runs at most this long per worker pass. */
const PASS_BUDGET_MS = 20_000;
/** Retry delay after the app didn't answer. */
const RETRY_MS = 10 * 60_000;

let nextSlot = 0;
/** Tests start from a clear schedule. */
export const resetSpacing = () => {
  nextSlot = 0;
};
/** Waits for this instance's turn, so detection never sends more than a few requests a second across all monitors. */
export async function spaced(gapMs = probeSpacing.gapMs, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await sleep(at - now);
}

type Fetched = { sample: Sample; finalPath: string };

async function fetchSample(doFetch: typeof fetch, url: string, headers: Record<string, string>, method: HttpMethod = "GET"): Promise<Fetched | null> {
  await spaced();
  try {
    const res = await doFetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { ...headers, "user-agent": "Vardo-Uptime/1", "cache-control": "no-cache" },
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = res.body?.getReader();
    while (reader && bytes < HASH_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
    }
    await reader?.cancel().catch(() => {});
    const body = Buffer.concat(chunks).subarray(0, HASH_BODY_BYTES);
    let finalPath = new URL(url).pathname;
    try {
      if (res.url) finalPath = new URL(res.url).pathname;
    } catch {
      // keep the requested path
    }
    const sample: Sample = { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: body.byteLength, hash: hashBody(body), noRoute: isNoRoute(res.headers), cache: cacheOf(res.headers) };
    return { sample, finalPath };
  } catch {
    return null;
  }
}

export type Detection =
  /** No answer, a 5xx with no health path, or Vardo's catch-all: try again later. */
  | { outcome: "unreachable" }
  | { outcome: "decided"; path: string | null; source: HealthSource; review: { status: number; reason: "status" | "login" } | null };

const join = (base: string, path: string) => base.replace(/\/+$/, "") + path;

type Candidate = { path: string; source: HealthSource; status?: number[] };

/**
 * Looks for a health endpoint under `base` (an origin plus any path prefix): the app's own healthcheck path, then known paths for its images,
 * then the usual names. One answered by the origin beats one answered by a cache. Falls back to the homepage, and says when it answers below 500 but not 2xx.
 */
export async function detectHealth(input: { base: string; healthcheckPath?: string | null; imagePaths?: ImageHealthPath[]; headers?: Record<string, string>; fetch: typeof fetch }): Promise<Detection> {
  const headers = input.headers ?? {};
  const home = await fetchSample(input.fetch, input.base, headers);
  // Vardo's catch-all answers every path of a host with no route, so nothing past the homepage is worth asking.
  if (!home || home.sample.noRoute) return { outcome: "unreachable" };
  const verdict = judgeHomepage(home.sample.status, home.finalPath, new URL(input.base).pathname);

  // A broken homepage says nothing about the app; a health path might still answer.
  const candidates: Candidate[] = [];
  const add = (c: Candidate) => {
    if (!candidates.some((x) => x.path === c.path)) candidates.push(c);
  };
  if (input.healthcheckPath) add({ path: input.healthcheckPath, source: "healthcheck" });
  for (const p of input.imagePaths ?? []) add({ path: p.path, source: "image", status: p.status });
  for (const path of HEALTH_PATHS) add({ path, source: "probe" });

  let cached: Candidate | null = null;
  for (const c of candidates) {
    const probe = await fetchSample(input.fetch, join(input.base, c.path), headers);
    if (!probe) continue;
    const ok = c.status ? qualifiesAsImageHealth(probe.sample, home.sample, c.status) : qualifiesAsHealth(probe.sample, home.sample);
    if (!ok) continue;
    if (!probe.sample.cache) return { outcome: "decided", path: c.path, source: c.source, review: null };
    cached ??= c;
  }
  if (cached) return { outcome: "decided", path: cached.path, source: cached.source, review: null };
  if (verdict.kind === "unreachable") return { outcome: "unreachable" };
  return { outcome: "decided", path: null, source: "homepage", review: verdict.kind === "review" ? { status: verdict.status, reason: verdict.reason } : null };
}

/** The images of the services a domain routes to: the app's own image, or its compose services'. */
export async function imagesFor(appId: string, serviceName: string | null): Promise<string[]> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId), columns: { imageName: true, composeContent: true, parentAppId: true, composeService: true } });
  if (!app) return [];
  const out = app.imageName ? [app.imageName] : [];
  let content = app.composeContent;
  if (!content && app.parentAppId) content = (await db.query.apps.findFirst({ where: eq(apps.id, app.parentAppId), columns: { composeContent: true } }))?.composeContent ?? null;
  if (!content) return out;
  try {
    const services = parseCompose(content).services ?? {};
    const wanted = app.composeService ?? serviceName;
    const names = wanted && services[wanted] ? [wanted] : Object.keys(services);
    for (const name of names) if (services[name]?.image) out.push(services[name].image!);
  } catch {
    // An unreadable compose file names no images.
  }
  return out;
}

/** The path the app's compose healthcheck requests from the container, for the service this domain routes to. */
export async function healthcheckPathFor(appId: string, serviceName: string | null): Promise<string | null> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId), columns: { composeContent: true, parentAppId: true, composeService: true } });
  if (!app) return null;
  let content = app.composeContent;
  if (!content && app.parentAppId) {
    content = (await db.query.apps.findFirst({ where: eq(apps.id, app.parentAppId), columns: { composeContent: true } }))?.composeContent ?? null;
  }
  if (!content) return null;
  try {
    const services = parseCompose(content).services ?? {};
    const wanted = app.composeService ?? serviceName;
    const names = wanted && services[wanted] ? [wanted] : Object.keys(services);
    for (const name of names) {
      const path = parseHealthcheckPath(services[name]?.healthcheck?.test);
      if (path) return path;
    }
  } catch {
    // An unreadable compose file has no healthcheck to read.
  }
  return null;
}

async function applyDetection(row: UptimeMonitorRow, detection: Detection, now: number): Promise<void> {
  if (detection.outcome === "unreachable") {
    await db.update(uptimeMonitors).set({ healthDueAt: new Date(now + RETRY_MS) }).where(eq(uptimeMonitors.id, row.id));
    return;
  }
  const base = baseUrlOf(row);
  if (!base || row.check.type !== "http") return;
  const check: HttpCheck = { ...row.check, url: detection.path ? join(base, detection.path) : base };
  await db
    .update(uptimeMonitors)
    .set({
      check,
      healthPath: detection.path,
      healthSource: detection.source,
      intervalSec: autoIntervalFor({ healthSource: detection.source, overrides: row.overrides }),
      healthDueAt: new Date(now + DAY_MS),
      // An edited expected status already says what counts as up.
      reviewStatus: row.overrides?.expectedStatus ? null : (detection.review?.status ?? null),
      reviewReason: row.overrides?.expectedStatus ? null : (detection.review?.reason ?? null),
      updatedAt: new Date(),
    })
    .where(eq(uptimeMonitors.id, row.id));
}

/** Detects for the automatic monitors that are due, one at a time within a time budget. Returns how many it decided. */
export async function runHealthDetection(now = Date.now(), deps?: { fetch?: typeof fetch }): Promise<number> {
  if (detecting) return 0;
  detecting = true;
  try {
    return await detectDue(now, deps);
  } finally {
    detecting = false;
  }
}

let detecting = false;

async function detectDue(now: number, deps?: { fetch?: typeof fetch }): Promise<number> {
  const rows = await db
    .select({ monitor: uptimeMonitors, app: runStateColumns, serviceName: domains.serviceName })
    .from(uptimeMonitors)
    .leftJoin(apps, eq(apps.id, uptimeMonitors.appId))
    .leftJoin(domains, eq(domains.id, uptimeMonitors.domainId))
    .where(
      and(
        eq(uptimeMonitors.source, "auto"),
        eq(uptimeMonitors.enabled, true),
        isNull(uptimeMonitors.meshPeerId),
        isNull(uptimeMonitors.reviewAnswer),
        sql`${uptimeMonitors.overrides}->'path' is null`,
        or(isNull(uptimeMonitors.healthDueAt), lte(uptimeMonitors.healthDueAt, new Date(now))),
      ),
    );
  const due = rows.filter((r) => (r.monitor.domainId || r.monitor.environmentId) && !appNotRunning(r.app));
  if (due.length === 0) return 0;

  const started = Date.now();
  const checks: Partial<Record<PolicyLevel, typeof fetch>> = {};
  let decided = 0;
  for (const { monitor, serviceName } of due) {
    if (Date.now() - started > PASS_BUDGET_MS) break;
    try {
      const base = baseUrlOf(monitor);
      if (!base) continue;
      const level = levelOf(monitor);
      const doFetch = deps?.fetch ?? (checks[level] ??= (await checkDeps(level)).fetch);
      const healthcheckPath = monitor.appId ? await healthcheckPathFor(monitor.appId, serviceName) : null;
      const imagePaths = monitor.appId ? imageHealthPaths(await imagesFor(monitor.appId, serviceName)) : [];
      const detection = await detectHealth({ base, healthcheckPath, imagePaths, headers: openHeaders(monitor.headersEncrypted, monitor), fetch: doFetch });
      await applyDetection(monitor, detection, now);
      if (detection.outcome === "decided") decided++;
    } catch (err) {
      log.warn(`Health detection for ${monitor.id} failed:`, err);
      await db.update(uptimeMonitors).set({ healthDueAt: new Date(now + RETRY_MS) }).where(eq(uptimeMonitors.id, monitor.id));
    }
  }
  return decided;
}

/** Runs detection for the app's automatic monitors on the next pass, such as after a deploy. */
export async function requestHealthDetection(appId: string): Promise<void> {
  const stack = await db.select({ id: apps.id }).from(apps).where(or(eq(apps.id, appId), eq(apps.parentAppId, appId)));
  await db
    .update(uptimeMonitors)
    .set({ healthDueAt: null })
    .where(and(eq(uptimeMonitors.source, "auto"), isNull(uptimeMonitors.reviewAnswer), sql`${uptimeMonitors.overrides}->'path' is null`, inArray(uptimeMonitors.appId, stack.map((a) => a.id))));
}

/** Detection for a URL typed into the Add monitor sheet. Nothing is stored. */
export async function detectForUrl(scope: Scope, rawUrl: string, headers?: Record<string, string>): Promise<DetectedHealth> {
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new UptimeInputError("Enter an http or https URL.");
  }
  const level: PolicyLevel = scope.kind === "org" ? "strict" : "operator";
  const refusal = await targetRefusal({ type: "http", url: url.toString(), expectedStatus: { ...AUTO_EXPECTED_STATUS }, timeoutMs: 10_000 }, level);
  if (refusal) throw new UptimeInputError(`That address isn't allowed for monitors: ${refusal}.`);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const detection = await detectHealth({ base, headers, fetch: (await checkDeps(level)).fetch });
  if (detection.outcome === "unreachable") return { found: false, reachable: false, path: null, source: null, url: url.toString(), review: null };
  return { found: detection.path !== null, reachable: true, path: detection.path, source: detection.source, url: detection.path ? join(base, detection.path) : url.toString(), review: detection.review };
}

/** Monitors of the org waiting on an answer, for Attention. */
export async function listReviews(orgId: string): Promise<ReviewItem[]> {
  const rows = await db
    .select({ id: uptimeMonitors.id, name: uptimeMonitors.name, status: uptimeMonitors.reviewStatus, reason: uptimeMonitors.reviewReason, appName: apps.name, app: runStateColumns })
    .from(uptimeMonitors)
    .leftJoin(apps, eq(apps.id, uptimeMonitors.appId))
    .where(and(eq(uptimeMonitors.organizationId, orgId), eq(uptimeMonitors.enabled, true), isNotNull(uptimeMonitors.reviewStatus), isNull(uptimeMonitors.reviewAnswer)));
  return rows.filter((r) => !appNotRunning(r.app)).map((r) => ({ monitorId: r.id, name: r.name, appName: r.appName, status: r.status!, reason: r.reason === "login" ? "login" : "status" }));
}

type Offer = { service: string; port: number; path: string };

/** The app's container healthcheck, and the one uptime could offer to add when the app has none. */
export async function containerHealthFor(orgId: string, appId: string): Promise<ContainerHealth> {
  const none: ContainerHealth = { hasHealthcheck: false, path: null, offerPath: null };
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { composeContent: true, containerPort: true, parentAppId: true, composeService: true },
  });
  if (!app) return none;
  let content = app.composeContent;
  if (!content && app.parentAppId) content = (await db.query.apps.findFirst({ where: eq(apps.id, app.parentAppId), columns: { composeContent: true } }))?.composeContent ?? null;
  if (!content) return none;
  try {
    const services = parseCompose(content).services ?? {};
    const own = app.composeService ? [app.composeService] : Object.keys(services);
    const present = own.some((n) => services[n]?.healthcheck && !services[n].healthcheck!.disable && services[n].healthcheck!.test);
    const path = await healthcheckPathFor(appId, null);
    if (present) return { hasHealthcheck: true, path, offerPath: null };
    const offer = await offerFor(orgId, appId);
    return { hasHealthcheck: false, path: null, offerPath: offer?.path ?? null };
  } catch {
    return none;
  }
}

async function offerFor(orgId: string, appId: string): Promise<Offer | null> {
  const app = await db.query.apps.findFirst({ where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)), columns: { composeContent: true, containerPort: true, parentAppId: true } });
  // A stack's services are changed on the parent.
  if (!app?.composeContent || app.parentAppId) return null;
  const monitor = (
    await db
      .select({ path: uptimeMonitors.healthPath, serviceName: domains.serviceName, port: domains.port })
      .from(uptimeMonitors)
      .innerJoin(domains, eq(domains.id, uptimeMonitors.domainId))
      .where(and(eq(uptimeMonitors.appId, appId), eq(uptimeMonitors.source, "auto"), isNotNull(uptimeMonitors.healthPath)))
  )[0];
  if (!monitor?.path) return null;
  const services = Object.keys(parseCompose(app.composeContent).services ?? {});
  const service = monitor.serviceName && services.includes(monitor.serviceName) ? monitor.serviceName : services.length === 1 ? services[0] : null;
  const port = monitor.port ?? app.containerPort;
  if (!service || !port) return null;
  return { service, port, path: monitor.path };
}

/** Adds a healthcheck on the uptime health path to the compose file. Takes effect on the next deploy. False when nothing can be offered. */
export async function adoptContainerHealthcheck(orgId: string, appId: string): Promise<boolean> {
  const offer = await offerFor(orgId, appId);
  const app = await db.query.apps.findFirst({ where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)), columns: { composeContent: true } });
  if (!offer || !app?.composeContent) return false;
  const compose = parseCompose(app.composeContent);
  const service = compose.services[offer.service];
  if (!service || service.healthcheck) return false;
  const url = `http://localhost:${offer.port}${offer.path}`;
  service.healthcheck = { test: ["CMD-SHELL", `curl -fsS ${url} || wget -q --spider ${url} || exit 1`], interval: "30s", timeout: "5s", retries: 3, start_period: "30s" };
  await db.update(apps).set({ composeContent: composeToYaml(compose), needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));
  return true;
}

export type ReviewInput =
  | { kind: "status"; status: number; method?: HttpMethod }
  | ({ kind: "headers"; shareHeaders?: boolean } & HeaderPatch)
  | { kind: "path"; path: string; method?: HttpMethod; status?: number }
  | { kind: "skip" };

const SAFE_PATH = /^\/[A-Za-z0-9._~/%-]{0,199}$/;

const validStatus = (status: number) => Number.isInteger(status) && status >= 100 && status <= 499;

function methodOf(method: string | undefined): HttpMethod | undefined {
  if (method === undefined || method === "GET") return undefined;
  if (!(HTTP_METHODS as readonly string[]).includes(method)) throw new UptimeInputError("Use GET, HEAD or POST.");
  return method as HttpMethod;
}

/** Stores the operator's answer to the review question. Answers survive detection and auto-sync. */
export async function answerReview(scope: Scope, id: string, input: ReviewInput, deps?: { fetch?: typeof fetch }): Promise<boolean> {
  const row = await ownedRow(scope, id);
  if (!row || row.source !== "auto" || row.check.type !== "http") return false;
  const clear = { reviewStatus: null, reviewReason: null, updatedAt: new Date() };
  const base = baseUrlOf(row)!;

  if (input.kind === "status") {
    if (!validStatus(input.status)) throw new UptimeInputError("Enter a status from 100 to 499.");
    const method = methodOf(input.method);
    const answer: ReviewAnswer = { kind: "status", status: input.status, ...(method ? { method } : {}) };
    const check = withAutoFields(row.check, autoCheckFor({ healthPath: row.healthPath, reviewAnswer: answer, overrides: row.overrides }, base));
    await db.update(uptimeMonitors).set({ ...clear, reviewAnswer: answer, check }).where(eq(uptimeMonitors.id, id));
  } else if (input.kind === "skip") {
    await db.update(uptimeMonitors).set({ ...clear, reviewAnswer: { kind: "skip" }, enabled: false }).where(eq(uptimeMonitors.id, id));
  } else if (input.kind === "path") {
    if (!SAFE_PATH.test(input.path)) throw new UptimeInputError("Enter a path that starts with /.");
    if (input.status !== undefined && !validStatus(input.status)) throw new UptimeInputError("Enter a status from 100 to 499.");
    const method = methodOf(input.method);
    const level = levelOf(row);
    const probe = await fetchSample(deps?.fetch ?? (await checkDeps(level)).fetch, join(base, input.path), openHeaders(row.headersEncrypted, row), method);
    const want = input.status;
    const answered = probe && !probe.sample.noRoute && (want !== undefined ? probe.sample.status === want : probe.sample.status >= 200 && probe.sample.status <= 299);
    if (!answered) throw new UptimeInputError(`${method ?? "GET"} ${input.path} didn't answer ${want ?? "2xx"}. Run Detect or try another path.`);
    const answer: ReviewAnswer = { kind: "path", path: input.path, ...(method ? { method } : {}), ...(want !== undefined ? { status: want } : {}) };
    const check = withAutoFields(row.check, autoCheckFor({ healthPath: input.path, reviewAnswer: answer, overrides: row.overrides }, base));
    await db
      .update(uptimeMonitors)
      .set({ ...clear, reviewAnswer: answer, healthPath: input.path, healthSource: "probe", intervalSec: autoIntervalFor({ healthSource: "probe", overrides: row.overrides }), healthDueAt: null, check })
      .where(eq(uptimeMonitors.id, id));
  } else {
    const { sealed, names } = applyHeaderPatch(row.headersEncrypted, row, input);
    await db
      .update(uptimeMonitors)
      .set({ ...clear, headersEncrypted: sealed, headerNames: names, shareHeaders: input.shareHeaders ?? row.shareHeaders, healthDueAt: null })
      .where(eq(uptimeMonitors.id, id));
  }
  return true;
}
