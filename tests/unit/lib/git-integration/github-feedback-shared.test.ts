// A rollback the worker runs rewrites the PR comments web wrote, with every app's row, through the shared store.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRedis, type FakeRedis } from "../../helpers/fake-redis";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { createFeedback, type DeployInfo, type FeedbackDeps, type GitHub } from "@/lib/git-integration/github-feedback";
import { FEEDBACK_STATE_TTL_MS, redisFeedbackStore, type FeedbackRedis } from "@/lib/git-integration/github-feedback-store";

type Call = { method: string; path: string; body?: unknown };

const SHA = "abcdef1234567";

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

const APPS: Record<string, { appId: string; appName: string }> = {
  "dep-web": { appId: "app-web", appName: "web" },
  "dep-api": { appId: "app-api", appName: "api" },
  "dep-api-2": { appId: "app-api", appName: "api" },
};

function info(deploymentId: string, over: Partial<DeployInfo>): DeployInfo {
  return {
    deploymentId,
    ...APPS[deploymentId],
    organizationId: "org-1",
    trigger: "webhook",
    repo: "acme/widget",
    branch: "main",
    pinnedSha: null,
    environment: "production",
    environmentUrl: null,
    pr: null,
    enabled: true,
    ...over,
  };
}

/** One process's feedback: its own memory, the shared store. */
function processFeedback(redis: FakeRedis, over: Partial<DeployInfo>, calls: Call[], extra: Partial<FeedbackDeps> = {}) {
  let pullLookups = 0;
  const gh: GitHub = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (method === "GET" && /commits\/.*\/pulls/.test(path)) {
        pullLookups++;
        return [{ number: 8, merged_at: "2026-01-01", merge_commit_sha: SHA, base: { ref: "main" } }] as T;
      }
      if (method === "GET" && /\/issues\/\d+\/comments/.test(path)) return [] as T;
      if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) return { id: 900 } as T;
      if (method === "POST" && /\/deployments$/.test(path)) return { id: 500 } as T;
      if (method === "GET" && /\/deployments\?/.test(path)) {
        return Object.keys(APPS).map((id, i) => ({ id: 600 + i, payload: { vardo: { deployment: id } } })) as T;
      }
      return undefined as T;
    },
  };
  const deps: FeedbackDeps = {
    loadInfo: async (deploymentId) => info(deploymentId, over),
    readSha: async () => SHA,
    instance: async () => ({ id: "inst-1", consoleUrl: "https://console.example.com" }),
    resolveInstallation: async () => 11,
    client: async () => gh,
    markBlocked: async () => {},
    intervalMs: 0,
    store: redisFeedbackStore(redis as unknown as FeedbackRedis),
    ...extra,
  };
  return { feedback: createFeedback(deps), pullLookups: () => pullLookups };
}

function deploy(feedback: ReturnType<typeof createFeedback>, deploymentId: string) {
  const t = feedback.trackDeploy(deploymentId, { trigger: "webhook" });
  for (const s of ["clone", "compose", "build", "deploy"]) t.stage(s, "running");
  t.finish({ status: "success", durationMs: 1000 });
}

const commentEdits = (calls: Call[], issue: number) =>
  calls.filter((c) => (c.method === "PATCH" && c.path.includes("/issues/comments/")) || (c.method === "POST" && c.path.endsWith(`/issues/${issue}/comments`)));
const lastBody = (calls: Call[], issue: number) => (commentEdits(calls, issue).at(-1)?.body as { body: string } | undefined)?.body ?? "";

let redis: FakeRedis;
beforeEach(() => {
  redis = createFakeRedis();
});

describe("PR comment state across processes", () => {
  const preview = { environment: "preview" as const, pr: { repo: "acme/widget", number: 4 } };

  it("keeps the other apps' rows when the worker rolls one back", async () => {
    const webCalls: Call[] = [];
    const web = processFeedback(redis, preview, webCalls);
    deploy(web.feedback, "dep-web");
    await settle();
    deploy(web.feedback, "dep-api");
    await settle();
    expect(lastBody(webCalls, 4)).toContain("**Preview live at `abcdef1`**");

    const workerCalls: Call[] = [];
    const worker = processFeedback(redis, preview, workerCalls);
    await worker.feedback.deployRolledBack("dep-api");
    await settle();

    const body = lastBody(workerCalls, 4);
    expect(body).toContain("| web | Live");
    expect(body).toMatch(/\| api \| Failed · The new version stopped soon after going live\. \| \[Log\]/);
    // Edits the comment web created instead of searching for it.
    expect(workerCalls.some((c) => c.method === "PATCH" && c.path === "/repos/acme/widget/issues/comments/900")).toBe(true);
    expect(workerCalls.some((c) => c.method === "GET" && c.path.includes("/issues/4/comments"))).toBe(false);
  });

  it("keeps the merged comment's rows and PR when the worker rolls one back", async () => {
    const webCalls: Call[] = [];
    const web = processFeedback(redis, {}, webCalls);
    deploy(web.feedback, "dep-web");
    await settle();
    deploy(web.feedback, "dep-api");
    await settle();

    const workerCalls: Call[] = [];
    const worker = processFeedback(redis, {}, workerCalls);
    await worker.feedback.deployRolledBack("dep-api");
    await settle();

    const body = lastBody(workerCalls, 8);
    expect(body).toContain("Rolled back in production");
    expect(body).toMatch(/\| web \| Live/);
    expect(body).toMatch(/\| api \| Rolled back/);
    expect(body).not.toContain("still serving");
    expect(worker.pullLookups()).toBe(0);
  });

  it("names the restored commit only when the rollback says it's serving", async () => {
    const web = processFeedback(redis, {}, []);
    deploy(web.feedback, "dep-api");
    await settle();

    const readServingSha = vi.fn(async () => "a91c0e2ffff");
    const workerCalls: Call[] = [];
    const worker = processFeedback(redis, {}, workerCalls, { readServingSha });
    await worker.feedback.deployRolledBack("dep-api", { serving: true });
    await settle();
    expect(readServingSha).toHaveBeenCalledWith("dep-api", "app-api");
    expect(lastBody(workerCalls, 8)).toContain("**Rolled back in production at `abcdef1`**\n\nThe new version stopped soon after going live. `a91c0e2` is still serving traffic.\n");
  });

  it("still updates the comment from this process's state when Redis is down", async () => {
    redis.ctl.down = true;
    const calls: Call[] = [];
    const web = processFeedback(redis, preview, calls);
    deploy(web.feedback, "dep-web");
    await settle();
    expect(lastBody(calls, 4)).toContain("**Preview live at `abcdef1`**");
  });
});

describe("a deploy the sweeper timed out", () => {
  const preview = { environment: "preview" as const, pr: { repo: "acme/widget", number: 4 } };
  const TIMEOUT = "Deployment timed out after 45 minutes";
  const READABLE = "The deploy took longer than the 45 minute limit.";

  /** Starts a deploy that never reports its end, as when its process dies. */
  function strand(feedback: ReturnType<typeof createFeedback>, deploymentId: string) {
    const t = feedback.trackDeploy(deploymentId, { trigger: "webhook" });
    for (const s of ["clone", "compose", "build"]) t.stage(s, "running");
  }

  const githubWrites = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

  it("fails its PR row, commit status and deployment with the readable text", async () => {
    const web = processFeedback(redis, preview, []);
    deploy(web.feedback, "dep-web");
    strand(web.feedback, "dep-api");
    await settle();

    const sweeperCalls: Call[] = [];
    const sweeper = processFeedback(redis, preview, sweeperCalls, { readStatus: async () => "failed" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 2_700_000);
    await settle();

    const body = lastBody(sweeperCalls, 4);
    expect(body).toContain("**Preview failed at `abcdef1`**");
    expect(body).toContain(`| api | Failed · ${READABLE} | [Log](https://console.example.com/apps/app-api/deployments/dep-api)`);
    expect(body).toContain("| web | Live |");
    expect(sweeperCalls.find((c) => c.path === `/repos/acme/widget/statuses/${SHA}`)?.body).toMatchObject({
      state: "failure",
      context: "vardo/api",
      description: READABLE,
    });
    expect(sweeperCalls.find((c) => c.path === "/repos/acme/widget/deployments/601/statuses")?.body).toMatchObject({
      state: "failure",
      description: READABLE,
    });
  });

  it("fails the merged PR's row in production", async () => {
    const web = processFeedback(redis, {}, []);
    deploy(web.feedback, "dep-web");
    strand(web.feedback, "dep-api");
    await settle();

    const sweeperCalls: Call[] = [];
    const sweeper = processFeedback(redis, {}, sweeperCalls, { readStatus: async () => "failed" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 2_700_000);
    await settle();
    const body = lastBody(sweeperCalls, 8);
    expect(body).toContain(`| api | Failed · ${READABLE} |`);
    expect(body).toContain("| web | Live |");
  });

  it("stays quiet for an app without GitHub feedback", async () => {
    const calls: Call[] = [];
    const sweeper = processFeedback(redis, preview, calls, { loadInfo: async () => null, readStatus: async () => "failed" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 1);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("leaves a row the deploy already took Live", async () => {
    const web = processFeedback(redis, preview, []);
    deploy(web.feedback, "dep-api");
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, preview, calls, { readStatus: async () => "failed" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 1);
    await settle();
    expect(githubWrites(calls)).toHaveLength(0);
  });

  it("leaves the merged PR's Live row in production", async () => {
    const web = processFeedback(redis, {}, []);
    deploy(web.feedback, "dep-api");
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, {}, calls, { readStatus: async () => "failed" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 1);
    await settle();
    expect(commentEdits(calls, 8)).toHaveLength(0);
  });

  it("does nothing once the deployment row is no longer failed", async () => {
    const web = processFeedback(redis, preview, []);
    strand(web.feedback, "dep-api");
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, preview, calls, { readStatus: async () => "success" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 1);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("leaves a newer deploy's row alone", async () => {
    const web = processFeedback(redis, preview, []);
    strand(web.feedback, "dep-api");
    await settle();
    strand(web.feedback, "dep-api-2");
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, preview, calls, { readStatus: async () => "failed" });
    await sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 1);
    await settle();
    expect(githubWrites(calls)).toHaveLength(0);
  });

  it("never throws when GitHub fails", async () => {
    const web = processFeedback(redis, preview, []);
    strand(web.feedback, "dep-api");
    await settle();
    const sweeper = processFeedback(redis, preview, [], {
      readStatus: async () => "failed",
      client: async () => ({ request: async () => { throw new Error("network"); } }),
    });
    await expect(sweeper.feedback.deployTimedOut("dep-api", TIMEOUT, 1)).resolves.toBeUndefined();
    await settle();
  });
});

describe("a queued deploy the sweeper cancelled", () => {
  const preview = { environment: "preview" as const, pr: { repo: "acme/widget", number: 4 } };
  const ORPHANED = "Deployment never started — the process that queued it stopped and was cancelled";

  it("fails its queued PR row and errors its commit status", async () => {
    const web = processFeedback(redis, preview, []);
    web.feedback.trackDeploy("dep-api", { trigger: "webhook" });
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, preview, calls, { readStatus: async () => "cancelled" });
    await sweeper.feedback.queuedDeployCancelled("dep-api", ORPHANED);
    await settle();

    const body = lastBody(calls, 4);
    expect(body).toContain("**Preview failed**\n\nThe deploy was cancelled before it started.\n");
    expect(body).toContain("| api | Failed |");
    expect(calls.find((c) => c.path === `/repos/acme/widget/statuses/${SHA}`)?.body).toMatchObject({
      state: "error",
      description: "The deploy was cancelled before it started.",
    });
  });

  it("leaves the merged PR alone in production, like any cancel", async () => {
    const web = processFeedback(redis, {}, []);
    deploy(web.feedback, "dep-web");
    web.feedback.trackDeploy("dep-api", { trigger: "webhook" });
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, {}, calls, { readStatus: async () => "cancelled" });
    await sweeper.feedback.queuedDeployCancelled("dep-api", ORPHANED);
    await settle();
    expect(commentEdits(calls, 8)).toHaveLength(0);
    expect(calls.find((c) => c.path === `/repos/acme/widget/statuses/${SHA}`)?.body).toMatchObject({ state: "error" });
  });

  it("does nothing once the deploy has started", async () => {
    const web = processFeedback(redis, preview, []);
    web.feedback.trackDeploy("dep-api", { trigger: "webhook" });
    await settle();

    const calls: Call[] = [];
    const sweeper = processFeedback(redis, preview, calls, { readStatus: async () => "running" });
    await sweeper.feedback.queuedDeployCancelled("dep-api", ORPHANED);
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe("redisFeedbackStore", () => {
  it("keeps a field per row, so two writers' rows both survive, for the rollback watch window", async () => {
    const store = redisFeedbackStore(redis as unknown as FeedbackRedis);
    await store.savePr("acme/widget#4", { sha: SHA, rows: [{ app: "web", state: "live" }], appIds: ["app-web"], orgIds: ["org-1"] });
    await store.savePr("acme/widget#4", { rows: [{ app: "api", state: "building" }], commentId: 900 });
    const pr = await store.loadPr("acme/widget#4");
    expect(pr).toMatchObject({ sha: SHA, commentId: 900, appIds: ["app-web"], orgIds: ["org-1"] });
    expect([...pr!.rows.keys()].sort()).toEqual(["api", "web"]);
    const ttl = await redis.pttl("github:feedback:pr:acme/widget#4");
    expect(ttl).toBeGreaterThan(FEEDBACK_STATE_TTL_MS - 1000);
    expect(FEEDBACK_STATE_TTL_MS).toBeGreaterThan(600_000);

    await store.removePr("acme/widget#4");
    expect(await store.loadPr("acme/widget#4")).toBeNull();
  });

  it("tells a looked-up PR of none apart from one not looked up yet", async () => {
    const store = redisFeedbackStore(redis as unknown as FeedbackRedis);
    await store.saveMerged(`acme/widget@${SHA}`, { rows: [{ app: "web", state: "live", sha: SHA }] });
    expect((await store.loadMerged(`acme/widget@${SHA}`))?.pr).toBeUndefined();
    await store.saveMerged(`acme/widget@${SHA}`, { pr: null });
    expect((await store.loadMerged(`acme/widget@${SHA}`))?.pr).toBeNull();
  });
});
