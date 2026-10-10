// Deploy feedback on GitHub: a sticky PR comment, deployments and commit statuses. Never blocks or fails a deploy.

import { logger } from "@/lib/logger";
import {
  commitStatusPayload,
  deployPageUrl,
  deploymentEnvironment,
  deploymentPayload,
  deploymentStatusPayload,
  mergedMarker,
  overallState,
  previewMarker,
  publicConsoleUrl,
  renderMergedComment,
  renderPreviewComment,
  type CommitState,
  type DeploymentState,
  type PreviewRow,
  type ProductionRow,
} from "./github-feedback-render";

const log = logger.child("github-feedback");

const API = "https://api.github.com";
export const REQUEST_TIMEOUT_MS = 10_000;
/** At most one edit per comment in this window. */
export const EDIT_INTERVAL_MS = 5_000;
/** How long feedback stays off for an app after GitHub refuses a permission. */
export const BLOCK_RETRY_MS = 24 * 60 * 60 * 1000;
const COMMENT_PAGES = 10;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

export type Permission = "deployments" | "statuses" | "pull_requests";

export const PERMISSION_LABEL: Record<Permission, string> = {
  deployments: "Deployments",
  statuses: "Commit statuses",
  pull_requests: "Pull requests",
};

export class GitHubPermissionError extends Error {
  constructor(readonly permission: Permission, message: string) {
    super(message);
    this.name = "GitHubPermissionError";
  }
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** GitHub asked us to slow down; no calls on this installation until `until`. */
export class GitHubRateLimitError extends Error {
  constructor(readonly until: number, message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/** Refused locally while the installation is backed off. */
export class GitHubBackoffError extends Error {
  constructor(readonly until: number) {
    super("GitHub installation is backed off");
    this.name = "GitHubBackoffError";
  }
}

const isBackoff = (err: unknown): err is GitHubRateLimitError | GitHubBackoffError =>
  err instanceof GitHubRateLimitError || err instanceof GitHubBackoffError;

/** Default wait when GitHub limits without saying for how long. */
export const RATE_LIMIT_DEFAULT_MS = 60_000;

/** When a rate-limited call may retry: `retry-after`, then `x-ratelimit-reset`, then a minute. */
export function rateLimitUntil(headers: Headers, now = Date.now()): number {
  const retryAfter = Number(headers.get("retry-after"));
  if (headers.get("retry-after") !== null && Number.isFinite(retryAfter)) return now + Math.max(0, retryAfter) * 1000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-reset") !== null && Number.isFinite(reset) && reset * 1000 > now) return reset * 1000;
  return now + RATE_LIMIT_DEFAULT_MS;
}

export type GitHub = {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
};

/** A client bound to one installation. */
type Conn = GitHub & { installationId: number };

/** The permission a REST path needs. */
export function permissionFor(path: string): Permission {
  if (/\/statuses\//.test(path)) return "statuses";
  if (/\/deployments/.test(path)) return "deployments";
  return "pull_requests";
}

/** A fetch client for one installation token with a timeout on every call. */
export function githubClient(token: string, fetchImpl: typeof fetch = fetch): GitHub {
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const rateLimited = (res.status === 403 || res.status === 429)
          && (res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text));
        if (rateLimited) {
          throw new GitHubRateLimitError(rateLimitUntil(res.headers), `GitHub rate limited ${method} ${path.split("?")[0]} (${res.status})`);
        }
        if (res.status === 403) {
          const permission = permissionFor(path);
          throw new GitHubPermissionError(permission, `GitHub refused ${PERMISSION_LABEL[permission]} access (403)`);
        }
        throw new GitHubApiError(res.status, `GitHub ${method} ${path.split("?")[0]} answered ${res.status}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json().catch(() => undefined)) as T;
    },
  };
}

type IssueComment = { id: number; body?: string | null; user?: { type?: string } | null };

/** The App's comment carrying the marker. Comments by people are skipped, so a pasted marker can't redirect edits. */
export async function findMarkedComment(gh: GitHub, repo: string, issue: number, marker: string): Promise<number | null> {
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const comments = await gh.request<IssueComment[]>("GET", `/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) return null;
    const hit = comments.find((c) => c.user?.type === "Bot" && c.body?.includes(marker));
    if (hit) return hit.id;
    if (comments.length < 100) return null;
  }
  return null;
}

/** Edits the marked comment or creates it. Returns its id, or null when it was missing and `create` is off. */
export async function upsertComment(
  gh: GitHub,
  opts: { repo: string; issue: number; marker: string; body: string; commentId?: number | null; create?: boolean },
): Promise<number | null> {
  let id = opts.commentId ?? (await findMarkedComment(gh, opts.repo, opts.issue, opts.marker));
  if (id) {
    try {
      await gh.request("PATCH", `/repos/${opts.repo}/issues/comments/${id}`, { body: opts.body });
      return id;
    } catch (err) {
      // Deleted on GitHub since it was cached.
      if (!(err instanceof GitHubApiError && err.status === 404) || !opts.commentId) throw err;
      id = await findMarkedComment(gh, opts.repo, opts.issue, opts.marker);
      if (id) {
        await gh.request("PATCH", `/repos/${opts.repo}/issues/comments/${id}`, { body: opts.body });
        return id;
      }
    }
  }
  if (opts.create === false) return null;
  const created = await gh.request<{ id: number }>("POST", `/repos/${opts.repo}/issues/${opts.issue}/comments`, { body: opts.body });
  return created?.id ?? null;
}

type Slot = {
  pending: string | null;
  pendingFinal: boolean;
  sent: string | null;
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  retries: number;
  send: (body: string) => Promise<void>;
  /** When the target installation is backed off until, or 0. */
  blockedUntil: () => number;
};

export type PushOpts = {
  /** A terminal state: held through a backoff and retried, never dropped. */
  final?: boolean;
  blockedUntil?: () => number;
};

/** Most retries of one final body through rate limits. */
const FINAL_RETRIES = 5;

/** Latest-wins sends per key, at most one per interval. Identical bodies are skipped; non-final ones are dropped while backed off. */
export function createCoalescer(intervalMs = EDIT_INTERVAL_MS, now: () => number = Date.now) {
  const slots = new Map<string, Slot>();

  const run = (slot: Slot) => {
    slot.timer = null;
    const body = slot.pending;
    const final = slot.pendingFinal;
    if (body === null) return;
    if (slot.blockedUntil() > now()) {
      if (!final) slot.pending = null;
      else schedule(slot);
      return;
    }
    slot.pending = null;
    slot.pendingFinal = false;
    if (body === slot.sent) return;
    slot.running = true;
    slot.lastAt = now();
    slot
      .send(body)
      .then(() => {
        slot.sent = body;
        slot.retries = 0;
      })
      .catch((err) => {
        // A final body that hit a limit waits it out, unless something newer replaced it.
        if (isBackoff(err) && final && slot.pending === null && slot.retries < FINAL_RETRIES) {
          slot.retries++;
          slot.pending = body;
          slot.pendingFinal = true;
          return;
        }
        log.warn(`GitHub comment update failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        slot.running = false;
        if (slot.pending !== null) schedule(slot);
      });
  };

  const schedule = (slot: Slot) => {
    if (slot.timer || slot.running) return;
    const wait = Math.max(0, slot.lastAt + intervalMs - now(), slot.blockedUntil() - now());
    if (wait === 0) return run(slot);
    slot.timer = setTimeout(() => run(slot), wait);
    slot.timer.unref?.();
  };

  return {
    push(key: string, body: string, send: (body: string) => Promise<void>, opts: PushOpts = {}) {
      let slot = slots.get(key);
      if (!slot) {
        slot = { pending: null, pendingFinal: false, sent: null, lastAt: 0, timer: null, running: false, retries: 0, send, blockedUntil: () => 0 };
        slots.set(key, slot);
        if (slots.size > 500) {
          for (const [k, s] of slots) {
            if (!s.timer && !s.running && s.pending === null) slots.delete(k);
            if (slots.size <= 250) break;
          }
        }
      }
      slot.send = send;
      slot.blockedUntil = opts.blockedUntil ?? (() => 0);
      slot.pending = body;
      slot.pendingFinal = !!opts.final;
      if (slot.blockedUntil() > now() && !opts.final) {
        slot.pending = null;
        return;
      }
      schedule(slot);
    },
  };
}

export type DeployInfo = {
  deploymentId: string;
  appId: string;
  appName: string;
  organizationId: string;
  trigger: string;
  /** owner/repo of the app's source, when it's on GitHub. */
  repo: string | null;
  branch: string | null;
  /** The commit pinned at request time, if any. */
  pinnedSha: string | null;
  environment: "production" | "preview" | "other";
  environmentUrl: string | null;
  /** The pull request a preview belongs to. */
  pr: { repo: string; number: number } | null;
  /** Off by setting, or blocked after a refused permission. */
  enabled: boolean;
};

export type InstanceInfo = { id: string; name: string; consoleUrl: string | null };

export type FeedbackDeps = {
  loadInfo: (deploymentId: string, trigger: string, pinnedSha: string | null) => Promise<DeployInfo | null>;
  readSha: (deploymentId: string) => Promise<string | null>;
  instance: () => Promise<InstanceInfo>;
  /** Installation that covers the repo for these orgs; null orgs trusts GitHub's answer alone. */
  resolveInstallation: (repo: string, organizationIds: string[] | null) => Promise<number | null>;
  client: (installationId: number) => Promise<GitHub>;
  markBlocked: (appIds: string[], organizationId: string | null, permission: Permission) => Promise<void>;
  /** GitHub refused a permission: re-read what the App and installations hold. */
  permissionDenied?: (permission: Permission) => void;
  now?: () => number;
  intervalMs?: number;
};

const GIT_TRIGGERS = new Set(["webhook", "relay", "poll"]);

/** Commit statuses go on deploys a commit asked for: pushes, relays, polls and deploys of a pinned SHA. */
export function wantsCommitStatus(info: Pick<DeployInfo, "trigger" | "pinnedSha" | "environment">): boolean {
  if (info.trigger === "rollback") return false;
  return GIT_TRIGGERS.has(info.trigger) || !!info.pinnedSha;
}

type PrState = { sha: string | null; rows: Map<string, PreviewRow>; commentId: number | null; touchedAt: number; appIds: Set<string>; orgIds: Set<string> };
type MergedState = { pr: number | null | undefined; rows: Map<string, ProductionRow>; commentId: number | null; touchedAt: number };

export type DeployTracker = {
  stage(stage: string, status: string): void;
  finish(result: { status: "success" | "failed" | "cancelled" | "superseded"; error?: string; durationMs?: number }): void;
};

const NOOP: DeployTracker = { stage() {}, finish() {} };

export function createFeedback(deps: FeedbackDeps) {
  const now = deps.now ?? Date.now;
  const coalescer = createCoalescer(deps.intervalMs ?? EDIT_INTERVAL_MS, now);
  const prs = new Map<string, PrState>();
  const merges = new Map<string, MergedState>();
  const blockedAt = new Map<string, number>();
  const isBlocked = (appId: string) => (blockedAt.get(appId) ?? -Infinity) > now() - BLOCK_RETRY_MS;
  const backoff = new Map<number, number>();
  const backedOffUntil = (installationId: number) => {
    const until = backoff.get(installationId) ?? 0;
    return until > now() ? until : 0;
  };

  const defer = (until: number, fn: () => Promise<unknown>) => {
    const t = setTimeout(() => void fn().catch(() => {}), Math.max(0, until - now()));
    t.unref?.();
  };

  const prune = () => {
    const cutoff = now() - STATE_TTL_MS;
    for (const [k, v] of prs) if (v.touchedAt < cutoff) prs.delete(k);
    for (const [k, v] of merges) if (v.touchedAt < cutoff) merges.delete(k);
  };

  /** A client for the repo's installation that refuses calls while GitHub has it backed off. */
  async function withClient(repo: string, orgIds: string[] | null): Promise<Conn | null> {
    const installationId = await deps.resolveInstallation(repo, orgIds);
    if (!installationId) return null;
    const inner = await deps.client(installationId);
    return {
      installationId,
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const until = backedOffUntil(installationId);
        if (until) throw new GitHubBackoffError(until);
        try {
          return await inner.request<T>(method, path, body);
        } catch (err) {
          if (err instanceof GitHubRateLimitError) {
            backoff.set(installationId, Math.max(backoff.get(installationId) ?? 0, err.until));
            log.warn(`${err.message}; backing off installation ${installationId} for ${Math.ceil((err.until - now()) / 1000)}s`);
          }
          throw err;
        }
      },
    };
  }

  type GuardOpts = {
    /** A terminal state: retried once the backoff lifts instead of skipped. */
    final?: boolean;
    conn?: Conn | null;
    /** Rethrow backoff errors to a caller that handles them. */
    propagate?: boolean;
    attempt?: number;
  };

  /** Runs one GitHub step; a refused permission blocks the apps involved, a backoff skips or defers it, anything else is logged. */
  async function guarded(appIds: string[], organizationId: string | null, label: string, fn: () => Promise<void>, opts: GuardOpts = {}): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      if (isBackoff(err)) {
        if (opts.propagate) throw err;
        const attempt = opts.attempt ?? 0;
        if (opts.final && opts.conn && attempt < FINAL_RETRIES) {
          const until = backedOffUntil(opts.conn.installationId) || now() + 1000;
          defer(until, () => guarded(appIds, organizationId, label, fn, { ...opts, attempt: attempt + 1 }));
        } else {
          log.info(`${label} skipped: GitHub rate limit`);
        }
        return true;
      }
      if (err instanceof GitHubPermissionError) {
        log.warn(`${label}: ${err.message}`);
        for (const id of appIds) blockedAt.set(id, now());
        await deps.markBlocked(appIds, organizationId, err.permission).catch(() => {});
        try {
          deps.permissionDenied?.(err.permission);
        } catch { /* a recheck never fails a deploy */ }
        return false;
      }
      log.warn(`${label} failed: ${err instanceof Error ? err.message : err}`);
      return true;
    }
  }

  function prKey(repo: string, number: number) {
    return `${repo.toLowerCase()}#${number}`;
  }

  async function pushPrComment(key: string, state: PrState, repo: string, number: number, opts: { removed?: boolean } = {}) {
    const instance = await deps.instance();
    const body = renderPreviewComment({
      instanceId: instance.id,
      instanceName: instance.name,
      sha: state.sha,
      rows: [...state.rows.values()],
      removed: opts.removed,
    });
    const appIds = [...state.appIds];
    const orgIds = state.orgIds.size > 0 ? [...state.orgIds] : null;
    const gh = await withClient(repo, orgIds);
    if (!gh) return;
    const overall = overallState([...state.rows.values()]);
    const final = !!opts.removed || overall === "live" || overall === "failed";
    coalescer.push(`pr:${key}`, body, async (latest) => {
      await guarded(appIds, orgIds?.[0] ?? null, `PR comment on ${repo}#${number}`, async () => {
        state.commentId = await upsertComment(gh, {
          repo,
          issue: number,
          marker: previewMarker(instance.id),
          body: latest,
          commentId: state.commentId,
          create: !opts.removed,
        });
      }, { propagate: true });
    }, { final, blockedUntil: () => backedOffUntil(gh.installationId) });
  }

  function prState(repo: string, number: number): [string, PrState] {
    const key = prKey(repo, number);
    let state = prs.get(key);
    if (!state) {
      state = { sha: null, rows: new Map(), commentId: null, touchedAt: now(), appIds: new Set(), orgIds: new Set() };
      prs.set(key, state);
    }
    state.touchedAt = now();
    return [key, state];
  }

  /** Records an app's row on its PR comment and schedules an edit. */
  function setPreviewRow(info: DeployInfo, row: Omit<PreviewRow, "app">, sha?: string | null) {
    if (!info.pr || isBlocked(info.appId)) return Promise.resolve();
    const [key, state] = prState(info.pr.repo, info.pr.number);
    state.appIds.add(info.appId);
    state.orgIds.add(info.organizationId);
    const sameRepo = info.repo?.toLowerCase() === info.pr.repo.toLowerCase();
    if (sha && sameRepo && sha !== state.sha) {
      // New push: apps not yet rebuilt are queued behind it.
      state.sha = sha;
      for (const [app, r] of state.rows) {
        if (app !== info.appName && (r.state === "live" || r.state === "failed")) state.rows.set(app, { app, state: "queued" });
      }
    }
    state.rows.set(info.appName, { app: info.appName, ...row });
    return pushPrComment(key, state, info.pr.repo, info.pr.number);
  }

  async function postCommitStatus(info: DeployInfo, sha: string, state: CommitState, description: string) {
    if (!info.repo || !wantsCommitStatus(info) || isBlocked(info.appId)) return;
    const gh = await withClient(info.repo, [info.organizationId]);
    if (!gh) return;
    const instance = await deps.instance();
    await guarded([info.appId], info.organizationId, `Commit status on ${info.repo}@${sha.slice(0, 7)}`, async () => {
      await gh.request("POST", `/repos/${info.repo}/statuses/${sha}`, commitStatusPayload({
        state,
        appName: info.appName,
        description,
        targetUrl: deployPageUrl(instance.consoleUrl, info.appId, info.deploymentId),
      }));
    }, { final: state !== "pending", conn: gh });
  }

  type GhDeployment = { id: number; environment?: string; payload?: unknown };

  /** The GitHub deployment this Vardo deploy created, found by its payload. */
  async function findGhDeployment(gh: GitHub, info: DeployInfo, sha: string | null): Promise<number | null> {
    const env = deploymentEnvironment(info.appName, info.pr?.number);
    const query = `environment=${encodeURIComponent(env)}${sha ? `&sha=${sha}` : ""}&per_page=30`;
    const list = await gh.request<GhDeployment[]>("GET", `/repos/${info.repo}/deployments?${query}`);
    const hit = (Array.isArray(list) ? list : []).find((d) => {
      const p = d.payload as { vardo?: { deployment?: string } } | undefined;
      return p?.vardo?.deployment === info.deploymentId;
    });
    return hit?.id ?? null;
  }

  function wantsDeployment(info: DeployInfo) {
    if (!info.repo) return false;
    if (info.environment === "production") return true;
    return info.environment === "preview" && !!info.pr && info.pr.repo.toLowerCase() === info.repo.toLowerCase();
  }

  async function mergedRow(info: DeployInfo, sha: string, row: Omit<ProductionRow, "app" | "sha">, attempt = 0): Promise<void> {
    if (!info.repo || info.environment !== "production" || info.trigger === "rollback" || isBlocked(info.appId)) return;
    const key = `${info.repo.toLowerCase()}@${sha}`;
    let state = merges.get(key);
    if (!state) {
      state = { pr: undefined, rows: new Map(), commentId: null, touchedAt: now() };
      merges.set(key, state);
    }
    state.touchedAt = now();
    state.rows.set(info.appName, { app: info.appName, sha, ...row });
    const gh = await withClient(info.repo, [info.organizationId]);
    if (!gh) return;
    const merged = state;
    if (merged.pr === undefined) {
      let ok: boolean;
      try {
        ok = await guarded([info.appId], info.organizationId, `Merged PR lookup for ${info.repo}@${sha.slice(0, 7)}`, async () => {
          merged.pr = await findMergedPull(gh, info.repo!, sha, info.branch);
        }, { propagate: true });
      } catch (err) {
        // The comment is a final state: look again once GitHub allows it.
        if (isBackoff(err) && attempt < FINAL_RETRIES) defer(backedOffUntil(gh.installationId) || now() + 1000, () => mergedRow(info, sha, row, attempt + 1));
        return;
      }
      if (!ok || merged.pr === undefined) return;
    }
    if (!merged.pr) return;
    const instance = await deps.instance();
    const body = renderMergedComment({ instanceId: instance.id, instanceName: instance.name, rows: [...merged.rows.values()] });
    const repo = info.repo;
    const pr = merged.pr;
    coalescer.push(`merged:${key}`, body, async (latest) => {
      await guarded([info.appId], info.organizationId, `Merged PR comment on ${repo}#${pr}`, async () => {
        merged.commentId = await upsertComment(gh, { repo, issue: pr, marker: mergedMarker(instance.id), body: latest, commentId: merged.commentId });
      }, { propagate: true });
    }, { final: true, blockedUntil: () => backedOffUntil(gh.installationId) });
  }

  function trackDeploy(deploymentId: string, opts: { trigger: string; gitSha?: string | null }): DeployTracker {
    try {
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>) => {
        chain = chain.then(fn).catch((err) => log.warn(`Deploy feedback for ${deploymentId} failed: ${err instanceof Error ? err.message : err}`));
      };

      let info: DeployInfo | null = null;
      let loaded = false;
      let sha: string | null = opts.gitSha ?? null;
      let ghDeploymentId: number | null = null;
      let ghClient: Conn | null = null;
      let started = false;

      const load = async () => {
        if (!loaded) {
          loaded = true;
          info = await deps.loadInfo(deploymentId, opts.trigger, opts.gitSha ?? null);
          if (info && !info.enabled) info = null;
          // The database is the record: a saved setting lifts a block.
          if (info) blockedAt.delete(info.appId);
          prune();
        }
        return info && !isBlocked(info.appId) ? info : null;
      };

      const createDeployment = async (i: DeployInfo, gh: Conn) => {
        const instance = await deps.instance();
        const created = await gh.request<{ id?: number }>("POST", `/repos/${i.repo}/deployments`, deploymentPayload({
          sha: sha!,
          appName: i.appName,
          prNumber: i.pr?.number,
          instanceId: instance.id,
          deploymentId,
        }));
        ghDeploymentId = created?.id ?? null;
      };

      const deploymentStatus = async (i: DeployInfo, state: DeploymentState, description: string, environmentUrl?: string | null) => {
        if (!ghClient || isBlocked(i.appId)) return;
        const final = state !== "queued" && state !== "in_progress";
        // A deployment skipped during a backoff is still created for its outcome.
        if (!ghDeploymentId && state !== "success" && state !== "failure") return;
        const gh = ghClient;
        const instance = await deps.instance();
        await guarded([i.appId], i.organizationId, `Deployment status on ${i.repo}`, async () => {
          if (!ghDeploymentId && sha) await createDeployment(i, gh);
          if (!ghDeploymentId) return;
          await gh.request("POST", `/repos/${i.repo}/deployments/${ghDeploymentId}/statuses`, deploymentStatusPayload({
            state,
            description,
            environmentUrl,
            logUrl: deployPageUrl(instance.consoleUrl, i.appId, deploymentId),
          }));
        }, { final, conn: gh });
      };

      /** Once the SHA is known: the commit goes pending and the GitHub deployment is created. */
      const begin = async (i: DeployInfo, queued = false) => {
        if (started) return;
        if (!sha) sha = await deps.readSha(deploymentId);
        if (!sha) return;
        started = true;
        const label = queued ? "Queued" : "Building";
        await postCommitStatus(i, sha, "pending", label);
        if (!wantsDeployment(i) || isBlocked(i.appId)) return;
        ghClient = await withClient(i.repo!, [i.organizationId]);
        if (!ghClient) return;
        const gh = ghClient;
        await guarded([i.appId], i.organizationId, `Deployment on ${i.repo}`, () => createDeployment(i, gh));
        await deploymentStatus(i, queued ? "queued" : "in_progress", label);
      };

      enqueue(async () => {
        const i = await load();
        if (!i) return;
        await setPreviewRow(i, { state: "queued" }, sha);
        if (sha) await begin(i, true);
      });

      return {
        stage(stage, status) {
          if (status !== "running") return;
          enqueue(async () => {
            const i = await load();
            if (!i) return;
            if (stage === "clone") {
              await deploymentStatus(i, "in_progress", "Building");
              await setPreviewRow(i, { state: "building" }, sha);
            } else if (stage === "compose" || stage === "build") {
              await begin(i);
              await setPreviewRow(i, { state: "building" }, sha);
            } else if (stage === "deploy") {
              await begin(i);
              await setPreviewRow(i, { state: "deploying" }, sha);
              await deploymentStatus(i, "in_progress", "Deploying");
            }
          });
        },
        finish(result) {
          enqueue(async () => {
            const i = await load();
            if (!i) return;
            await begin(i);
            const instance = await deps.instance();
            const logUrl = deployPageUrl(instance.consoleUrl, i.appId, deploymentId);
            const url = i.environmentUrl;
            if (result.status === "success") {
              await setPreviewRow(i, { state: "live", url }, sha);
              if (sha) await postCommitStatus(i, sha, "success", "Deployed");
              await deploymentStatus(i, "success", "Live", url);
              if (sha) await mergedRow(i, sha, { state: "live", durationMs: result.durationMs, url });
            } else if (result.status === "failed") {
              const reason = result.error || "Deploy failed";
              await setPreviewRow(i, { state: "failed", error: reason, logUrl }, sha);
              if (sha) await postCommitStatus(i, sha, "failure", reason);
              await deploymentStatus(i, "failure", reason);
              if (sha) await mergedRow(i, sha, { state: "failed", durationMs: result.durationMs, error: reason, logUrl });
            } else if (result.status === "cancelled") {
              await setPreviewRow(i, { state: "failed", error: "Cancelled", logUrl }, sha);
              if (sha) await postCommitStatus(i, sha, "error", "Cancelled");
              await deploymentStatus(i, "error", "Cancelled");
            } else {
              if (sha) await postCommitStatus(i, sha, "error", "Superseded by a newer deploy");
              await deploymentStatus(i, "inactive", "Superseded by a newer deploy");
            }
          });
        },
      };
    } catch (err) {
      log.warn(`Deploy feedback for ${deploymentId} not started: ${err instanceof Error ? err.message : err}`);
      return NOOP;
    }
  }

  /** A deploy that went live was rolled back afterwards. */
  async function deployRolledBack(deploymentId: string, reason = "Rolled back after the deploy"): Promise<void> {
    try {
      const info = await deps.loadInfo(deploymentId, "", null);
      if (!info || !info.enabled || !info.repo) return;
      const sha = await deps.readSha(deploymentId);
      const instance = await deps.instance();
      const logUrl = deployPageUrl(instance.consoleUrl, info.appId, deploymentId);
      await setPreviewRow(info, { state: "failed", error: reason, logUrl }, sha);
      if (!sha) return;
      await postCommitStatus(info, sha, "failure", reason);
      if (wantsDeployment(info)) {
        const gh = await withClient(info.repo, [info.organizationId]);
        if (gh) {
          await guarded([info.appId], info.organizationId, `Deployment status on ${info.repo}`, async () => {
            const id = await findGhDeployment(gh, info, sha);
            if (!id) return;
            await gh.request("POST", `/repos/${info.repo}/deployments/${id}/statuses`, deploymentStatusPayload({ state: "failure", description: reason, logUrl }));
          }, { final: true, conn: gh });
        }
      }
      await mergedRow(info, sha, { state: "rolled_back", error: reason, logUrl });
    } catch (err) {
      log.warn(`Rollback feedback for ${deploymentId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A PR's preview was torn down: the comment says so and its deployments go inactive. */
  async function previewRemoved(repo: string, number: number, organizationIds: string[] | null): Promise<void> {
    try {
      const [key, state] = prState(repo, number);
      for (const id of organizationIds ?? []) state.orgIds.add(id);
      await pushPrComment(key, state, repo, number, { removed: true });
      prs.delete(key);

      const gh = await withClient(repo, organizationIds);
      if (!gh) return;
      const instance = await deps.instance();
      const prefix = `preview/pr-${number}/`;
      await guarded([...state.appIds], organizationIds?.[0] ?? null, `Preview deployments on ${repo}#${number}`, async () => {
        const list = await gh.request<GhDeployment[]>("GET", `/repos/${repo}/deployments?per_page=100`);
        const latest = new Map<string, number>();
        for (const d of Array.isArray(list) ? list : []) {
          const p = d.payload as { vardo?: { instance?: string } } | undefined;
          if (!d.environment?.startsWith(prefix) || p?.vardo?.instance !== instance.id) continue;
          // Newest first, so the first per environment is the live one.
          if (!latest.has(d.environment)) latest.set(d.environment, d.id);
        }
        for (const id of latest.values()) {
          await gh.request("POST", `/repos/${repo}/deployments/${id}/statuses`, deploymentStatusPayload({ state: "inactive", description: "Preview removed" }));
        }
      }, { final: true, conn: gh });
    } catch (err) {
      log.warn(`Preview teardown feedback for ${repo}#${number} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A preview deployed outside the deploy engine, such as the console's own. */
  async function previewLive(repo: string, number: number, rows: { appName: string; domain: string }[]): Promise<void> {
    try {
      const [key, state] = prState(repo, number);
      for (const r of rows) state.rows.set(r.appName, { app: r.appName, state: "live", url: `https://${r.domain}` });
      await pushPrComment(key, state, repo, number);
    } catch (err) {
      log.warn(`Preview feedback for ${repo}#${number} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { trackDeploy, deployRolledBack, previewRemoved, previewLive };
}

/** The merged pull request whose merge produced this commit. */
export async function findMergedPull(gh: GitHub, repo: string, sha: string, branch: string | null): Promise<number | null> {
  type Pull = { number: number; merged_at?: string | null; merge_commit_sha?: string | null; base?: { ref?: string } };
  const pulls = await gh.request<Pull[]>("GET", `/repos/${repo}/commits/${sha}/pulls`);
  const hit = (Array.isArray(pulls) ? pulls : []).find(
    (p) => !!p.merged_at && p.merge_commit_sha === sha && (!branch || p.base?.ref === branch),
  );
  return hit?.number ?? null;
}

const installationCache = new Map<string, { id: number | null; expiresAt: number }>();
const INSTALLATION_TTL_MS = 10 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error("GitHub request timed out")), ms);
      t.unref?.();
    }),
  ]);
}

export type InstallationDeps = {
  getRepoInstallationId: (owner: string, repo: string) => Promise<number | null>;
  orgInstallations: (organizationId: string) => Promise<{ installationId: number; accountLogin: string }[]>;
};

/** The installation that covers the repo, linked to one of the orgs. GitHub's answer first, then the owner's account. */
export async function resolveInstallation(
  repoFullName: string,
  organizationIds: string[] | null,
  deps: InstallationDeps,
): Promise<number | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  let fromGitHub: number | null = null;
  let lookupFailed = false;
  try {
    fromGitHub = await deps.getRepoInstallationId(owner, repo);
  } catch {
    lookupFailed = true;
  }
  if (organizationIds === null) return fromGitHub;

  const linked = (await Promise.all(organizationIds.map((id) => deps.orgInstallations(id)))).flat();
  if (fromGitHub !== null) return linked.some((i) => i.installationId === fromGitHub) ? fromGitHub : null;
  if (!lookupFailed) return null;
  return linked.find((i) => i.accountLogin.toLowerCase() === owner.toLowerCase())?.installationId ?? null;
}

async function cachedInstallation(repo: string, organizationIds: string[] | null): Promise<number | null> {
  const key = `${(organizationIds ?? ["*"]).slice().sort().join(",")}:${repo.toLowerCase()}`;
  const hit = installationCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.id;
  const { getRepoInstallationId } = await import("./app");
  const { orgInstallations } = await import("./org-installations");
  const id = await withTimeout(resolveInstallation(repo, organizationIds, { getRepoInstallationId, orgInstallations }));
  installationCache.set(key, { id, expiresAt: Date.now() + (id ? INSTALLATION_TTL_MS : 60_000) });
  return id;
}

// getInstallationToken reuses each token until near expiry.
async function installationClient(installationId: number): Promise<GitHub> {
  const { getInstallationToken } = await import("./app");
  return githubClient(await withTimeout(getInstallationToken(installationId)));
}

let instancePromise: Promise<InstanceInfo> | null = null;

async function loadInstance(): Promise<InstanceInfo> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const { getInstanceId } = await import("@/lib/constants");
      let name = "Vardo";
      try {
        const { getInstanceDisplayName } = await import("@/lib/system-settings");
        name = (await getInstanceDisplayName()) || name;
      } catch { /* default stands */ }
      return { id: await getInstanceId(), name, consoleUrl: publicConsoleUrl(process.env.NEXT_PUBLIC_APP_URL) };
    })().catch((err) => {
      instancePromise = null;
      throw err;
    });
  }
  return instancePromise;
}

async function loadInfo(deploymentId: string, trigger: string, pinnedSha: string | null): Promise<DeployInfo | null> {
  const { db } = await import("@/lib/db");
  const { deployments, apps, organizations, environments, groupEnvironments } = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");
  const { parseGithubRepo } = await import("./clone-auth");

  const dep = await db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
    columns: { appId: true, trigger: true, environmentId: true, groupEnvironmentId: true },
  });
  if (!dep) return null;
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, dep.appId),
    columns: {
      id: true, name: true, organizationId: true, source: true, gitUrl: true, gitBranch: true,
      githubFeedback: true, githubFeedbackBlockedAt: true, isSystemManaged: true,
    },
  });
  if (!app || app.isSystemManaged) return null;
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, app.organizationId),
    columns: { githubFeedback: true },
  });

  const env = dep.environmentId
    ? await db.query.environments.findFirst({
        where: eq(environments.id, dep.environmentId),
        columns: { type: true, isDefault: true, domain: true, gitBranch: true, groupEnvironmentId: true },
      })
    : await db.query.environments.findFirst({
        where: and(eq(environments.appId, app.id), eq(environments.isDefault, true)),
        columns: { type: true, isDefault: true, domain: true, gitBranch: true, groupEnvironmentId: true },
      });
  const groupId = dep.groupEnvironmentId ?? env?.groupEnvironmentId ?? null;
  const group = groupId
    ? await db.query.groupEnvironments.findFirst({
        where: eq(groupEnvironments.id, groupId),
        columns: { type: true, prNumber: true, prUrl: true },
      })
    : null;

  const parsed = app.source === "git" && app.gitUrl ? parseGithubRepo(app.gitUrl) : null;
  const prMatch = group?.type === "preview" && group.prUrl ? group.prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/) : null;
  const pr = prMatch && group?.prNumber ? { repo: prMatch[1], number: group.prNumber } : null;
  if (!parsed && !pr) return null;

  const environment = !env || env.isDefault ? "production" : env.type === "preview" || pr ? "preview" : "other";
  const domain = env?.domain ?? (environment === "production"
    ? (await db.query.domains.findFirst({
        where: (d, { eq: e }) => e(d.appId, app.id),
        orderBy: (d, { desc }) => [desc(d.isPrimary)],
        columns: { domain: true },
      }))?.domain ?? null
    : null);

  const setting = app.githubFeedback ?? org?.githubFeedback ?? true;
  const blocked = !!app.githubFeedbackBlockedAt && app.githubFeedbackBlockedAt.getTime() > Date.now() - BLOCK_RETRY_MS;

  return {
    deploymentId,
    appId: app.id,
    appName: app.name,
    organizationId: app.organizationId,
    trigger: trigger || dep.trigger,
    repo: parsed ? `${parsed.owner}/${parsed.repo}` : null,
    branch: env?.gitBranch ?? app.gitBranch ?? null,
    pinnedSha,
    environment,
    environmentUrl: domain ? `https://${domain}` : null,
    pr,
    enabled: setting && !blocked,
  };
}

async function readSha(deploymentId: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const { deployments } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const row = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId), columns: { gitSha: true } });
  return row?.gitSha ?? null;
}

/** Turns feedback off for the apps and records why, once per outage. */
async function markBlocked(appIds: string[], organizationId: string | null, permission: Permission): Promise<void> {
  if (appIds.length === 0) return;
  const { db } = await import("@/lib/db");
  const { apps } = await import("@/lib/db/schema");
  const { and, inArray, isNull } = await import("drizzle-orm");
  const { recordActivity } = await import("@/lib/activity");
  const error = `The GitHub App can't write ${PERMISSION_LABEL[permission]}. Grant it in the App's permissions and approve the change on the installation.`;
  const now = new Date();
  const fresh = await db
    .update(apps)
    .set({ githubFeedbackError: error, githubFeedbackBlockedAt: now })
    .where(and(inArray(apps.id, appIds), isNull(apps.githubFeedbackError)))
    .returning({ id: apps.id, organizationId: apps.organizationId });
  await db.update(apps).set({ githubFeedbackBlockedAt: now }).where(inArray(apps.id, appIds));
  for (const row of fresh) {
    await recordActivity({
      organizationId: row.organizationId ?? organizationId ?? "",
      action: "app.github_feedback_failed",
      appId: row.id,
      metadata: { error, permission },
    }).catch(() => {});
  }
}

const feedback = createFeedback({
  loadInfo,
  readSha,
  instance: loadInstance,
  resolveInstallation: cachedInstallation,
  client: installationClient,
  markBlocked,
  permissionDenied: () => {
    void import("@/lib/integrations/check").then((m) => m.requestIntegrationRecheck()).catch(() => {});
  },
});

export const trackDeploy = feedback.trackDeploy;
export const deployRolledBack = feedback.deployRolledBack;
export const previewRemoved = feedback.previewRemoved;
export const previewLive = feedback.previewLive;
