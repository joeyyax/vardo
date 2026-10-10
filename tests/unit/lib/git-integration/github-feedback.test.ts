import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import {
  createCoalescer,
  createFeedback,
  findMarkedComment,
  findMergedPull,
  githubClient,
  GitHubApiError,
  GitHubPermissionError,
  GitHubRateLimitError,
  rateLimitUntil,
  resolveInstallation,
  upsertComment,
  type DeployInfo,
  type FeedbackDeps,
  type GitHub,
} from "@/lib/git-integration/github-feedback";

type Call = { method: string; path: string; body?: unknown };
type Route = [string, RegExp, (body: unknown, path: string) => unknown];

function fakeGitHub(routes: Route[] = []) {
  const calls: Call[] = [];
  const gh: GitHub = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      for (const [m, re, handler] of routes) {
        if (m === method && re.test(path)) return handler(body, path) as T;
      }
      return undefined as T;
    },
  };
  return { gh, calls };
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

const MARKER = "<!-- vardo:pr:inst-1 -->";

describe("marked comments", () => {
  it("edits the App's comment carrying the marker", async () => {
    const { gh, calls } = fakeGitHub([
      ["GET", /\/issues\/4\/comments/, () => [
        { id: 1, body: `${MARKER} pasted by a person`, user: { type: "User" } },
        { id: 2, body: `${MARKER}\nold`, user: { type: "Bot" } },
      ]],
    ]);
    const id = await upsertComment(gh, { repo: "acme/widget", issue: 4, marker: MARKER, body: "new" });
    expect(id).toBe(2);
    expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/repos/acme/widget/issues/comments/2", body: { body: "new" } });
  });

  it("creates the comment when none carries the marker", async () => {
    const { gh, calls } = fakeGitHub([
      ["GET", /comments/, () => [{ id: 1, body: "unrelated", user: { type: "Bot" } }]],
      ["POST", /\/issues\/4\/comments$/, () => ({ id: 9 })],
    ]);
    expect(await upsertComment(gh, { repo: "acme/widget", issue: 4, marker: MARKER, body: "new" })).toBe(9);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("doesn't create one when told not to", async () => {
    const { gh, calls } = fakeGitHub([["GET", /comments/, () => []]]);
    expect(await upsertComment(gh, { repo: "acme/widget", issue: 4, marker: MARKER, body: "x", create: false })).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("pages through long threads", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: n * 1000 + i, body: "chatter", user: { type: "User" } }));
    const { gh } = fakeGitHub([
      ["GET", /page=1$/, () => page(1)],
      ["GET", /page=2$/, () => [{ id: 77, body: MARKER, user: { type: "Bot" } }]],
    ]);
    expect(await findMarkedComment(gh, "acme/widget", 4, MARKER)).toBe(77);
  });

  it("finds the comment again when the cached one was deleted", async () => {
    const { gh, calls } = fakeGitHub([
      ["PATCH", /comments\/5$/, () => { throw new GitHubApiError(404, "gone"); }],
      ["GET", /comments/, () => [{ id: 6, body: MARKER, user: { type: "Bot" } }]],
    ]);
    expect(await upsertComment(gh, { repo: "acme/widget", issue: 4, marker: MARKER, body: "x", commentId: 5 })).toBe(6);
    expect(calls.at(-1)?.path).toBe("/repos/acme/widget/issues/comments/6");
  });
});

describe("resolveInstallation", () => {
  const orgInstallations = vi.fn(async (org: string) =>
    org === "org-1" ? [{ installationId: 11, accountLogin: "acme" }, { installationId: 12, accountLogin: "other" }] : [],
  );

  it("uses GitHub's answer when the org has that installation linked", async () => {
    const id = await resolveInstallation("acme/widget", ["org-1"], { getRepoInstallationId: async () => 12, orgInstallations });
    expect(id).toBe(12);
  });

  it("refuses an installation the org hasn't linked", async () => {
    const id = await resolveInstallation("acme/widget", ["org-2"], { getRepoInstallationId: async () => 11, orgInstallations });
    expect(id).toBeNull();
  });

  it("is null when the App isn't installed on the repo", async () => {
    const id = await resolveInstallation("acme/widget", ["org-1"], { getRepoInstallationId: async () => null, orgInstallations });
    expect(id).toBeNull();
  });

  it("falls back to the owner's account when GitHub can't be asked", async () => {
    const id = await resolveInstallation("acme/widget", ["org-1"], {
      getRepoInstallationId: async () => { throw new Error("offline"); },
      orgInstallations,
    });
    expect(id).toBe(11);
  });

  it("trusts GitHub alone when no org scopes it", async () => {
    const id = await resolveInstallation("acme/widget", null, { getRepoInstallationId: async () => 42, orgInstallations });
    expect(id).toBe(42);
  });
});

describe("findMergedPull", () => {
  it("picks the merged PR whose merge commit is the SHA", async () => {
    const { gh, calls } = fakeGitHub([
      ["GET", /commits\/abc\/pulls/, () => [
        { number: 3, merged_at: null, merge_commit_sha: "abc", base: { ref: "main" } },
        { number: 5, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "zzz", base: { ref: "main" } },
        { number: 7, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "abc", base: { ref: "main" } },
      ]],
    ]);
    expect(await findMergedPull(gh, "acme/widget", "abc", "main")).toBe(7);
    expect(calls[0].path).toBe("/repos/acme/widget/commits/abc/pulls");
    expect(await findMergedPull(gh, "acme/widget", "abc", "release")).toBeNull();
  });
});

describe("githubClient", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

  it("sends auth, a timeout and JSON", async () => {
    const fetchImpl = vi.fn(async () => response(201, { id: 3 }));
    const gh = githubClient("tok", fetchImpl as unknown as typeof fetch);
    expect(await gh.request("POST", "/repos/acme/widget/deployments", { ref: "abc" })).toEqual({ id: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widget/deployments");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("names the missing permission on a 403", async () => {
    const gh = githubClient("tok", (async () => response(403, { message: "Resource not accessible by integration" })) as unknown as typeof fetch);
    await expect(gh.request("POST", "/repos/acme/widget/statuses/abc", {})).rejects.toMatchObject({ permission: "statuses" });
    await expect(gh.request("POST", "/repos/acme/widget/deployments", {})).rejects.toMatchObject({ permission: "deployments" });
    await expect(gh.request("POST", "/repos/acme/widget/issues/4/comments", {})).rejects.toMatchObject({ permission: "pull_requests" });
  });

  it("treats a rate-limit 403 as a backoff until the reset", async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const gh = githubClient("tok", (async () => response(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })) as unknown as typeof fetch);
    const err = (await gh.request("GET", "/repos/acme/widget").catch((e) => e)) as GitHubRateLimitError;
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(err).not.toBeInstanceOf(GitHubPermissionError);
    expect(err.until).toBe(reset * 1000);
  });

  it("honors retry-after on a 429", async () => {
    const gh = githubClient("tok", (async () => response(429, "slow down", { "retry-after": "30" })) as unknown as typeof fetch);
    const before = Date.now();
    const err = (await gh.request("POST", "/repos/acme/widget/statuses/abc", {}).catch((e) => e)) as GitHubRateLimitError;
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(err.until).toBeGreaterThanOrEqual(before + 30_000);
    expect(err.until).toBeLessThan(before + 31_000);
  });
});

describe("rateLimitUntil", () => {
  it("prefers retry-after, then the reset, then a minute", () => {
    const now = 1_000_000;
    expect(rateLimitUntil(new Headers({ "retry-after": "5", "x-ratelimit-reset": "9999" }), now)).toBe(now + 5000);
    expect(rateLimitUntil(new Headers({ "x-ratelimit-reset": "2000" }), now)).toBe(2_000_000);
    expect(rateLimitUntil(new Headers(), now)).toBe(now + 60_000);
  });
});

describe("createCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends at most once per interval, latest body wins", async () => {
    const sent: string[] = [];
    const send = async (b: string) => { sent.push(b); };
    const c = createCoalescer(5000, () => Date.now());
    c.push("pr", "queued", send);
    await vi.advanceTimersByTimeAsync(0);
    c.push("pr", "building", send);
    c.push("pr", "deploying", send);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual(["queued"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["queued", "deploying"]);
  });

  it("skips a body identical to the last one sent", async () => {
    const send = vi.fn(async () => {});
    const c = createCoalescer(5000, () => Date.now());
    c.push("pr", "live", send);
    await vi.advanceTimersByTimeAsync(0);
    c.push("pr", "live", send);
    await vi.advanceTimersByTimeAsync(6000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops non-final edits while backed off and holds the final one", async () => {
    const sent: string[] = [];
    const send = async (b: string) => { sent.push(b); };
    const c = createCoalescer(5000, () => Date.now());
    const until = Date.now() + 30_000;
    const blockedUntil = () => (Date.now() < until ? until : 0);
    c.push("pr", "building", send, { blockedUntil });
    c.push("pr", "deploying", send, { blockedUntil });
    await vi.advanceTimersByTimeAsync(10_000);
    c.push("pr", "live", send, { final: true, blockedUntil });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["live"]);
  });

  it("retries a final edit that hit a rate limit", async () => {
    let until = 0;
    const sent: string[] = [];
    const send = vi.fn(async (b: string) => {
      if (sent.length === 0 && until === 0) {
        until = Date.now() + 20_000;
        throw new GitHubRateLimitError(until, "limited");
      }
      sent.push(b);
    });
    const c = createCoalescer(5000, () => Date.now());
    c.push("pr", "failed", send, { final: true, blockedUntil: () => (Date.now() < until ? until : 0) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual(["failed"]);
  });

  it("keeps keys independent", async () => {
    const send = vi.fn(async () => {});
    const c = createCoalescer(5000, () => Date.now());
    c.push("a", "1", send);
    c.push("b", "1", send);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

function info(over: Partial<DeployInfo> = {}): DeployInfo {
  return {
    deploymentId: "dep-1",
    appId: "app-1",
    appName: "web",
    organizationId: "org-1",
    trigger: "webhook",
    repo: "acme/widget",
    branch: "main",
    pinnedSha: null,
    environment: "production",
    environmentUrl: "https://widget.example.com",
    pr: null,
    enabled: true,
    ...over,
  };
}

function harness(opts: { info?: DeployInfo | null; routes?: Route[]; deps?: Partial<FeedbackDeps> } = {}) {
  const { gh, calls } = fakeGitHub([
    ...(opts.routes ?? []),
    ["POST", /\/deployments$/, () => ({ id: 500 })],
    ["POST", /\/issues\/\d+\/comments$/, () => ({ id: 900 })],
    ["GET", /\/issues\/\d+\/comments/, () => []],
  ]);
  const markBlocked = vi.fn(async () => {});
  const deps: FeedbackDeps = {
    loadInfo: vi.fn(async () => (opts.info === undefined ? info() : opts.info)),
    readSha: vi.fn(async () => "abcdef1234567"),
    instance: async () => ({ id: "inst-1", name: "Acme Vardo", consoleUrl: "https://console.example.com" }),
    resolveInstallation: vi.fn(async () => 11),
    client: vi.fn(async () => gh),
    markBlocked,
    intervalMs: 0,
    ...opts.deps,
  };
  return { feedback: createFeedback(deps), calls, deps, markBlocked };
}

function runDeploy(feedback: ReturnType<typeof createFeedback>, result: Parameters<ReturnType<ReturnType<typeof createFeedback>["trackDeploy"]>["finish"]>[0]) {
  const t = feedback.trackDeploy("dep-1", { trigger: "webhook" });
  for (const s of ["clone", "compose", "build", "deploy", "healthcheck"]) t.stage(s, "running");
  t.finish(result);
}

describe("deploy feedback", () => {
  it("walks a preview through comment, deployment and status", async () => {
    const { feedback, calls } = harness({
      info: info({ environment: "preview", pr: { repo: "acme/widget", number: 4 }, environmentUrl: "https://pr-4-web.example.com" }),
    });
    runDeploy(feedback, { status: "success", durationMs: 1000 });
    await settle();

    const statuses = calls.filter((c) => c.path.includes("/statuses/abcdef1234567")).map((c) => (c.body as { state: string }).state);
    expect(statuses).toEqual(["pending", "success"]);
    expect(calls.find((c) => c.path.includes("/statuses/abcdef1234567"))?.body).toMatchObject({
      context: "vardo/web",
      target_url: "https://console.example.com/apps/app-1/deployments/dep-1",
    });

    const created = calls.find((c) => c.method === "POST" && c.path === "/repos/acme/widget/deployments");
    expect(created?.body).toMatchObject({ ref: "abcdef1234567", environment: "preview/pr-4/web", transient_environment: true });
    const depStates = calls.filter((c) => c.path === "/repos/acme/widget/deployments/500/statuses").map((c) => c.body as { state: string; environment_url?: string });
    expect(depStates.map((s) => s.state)).toEqual(["in_progress", "in_progress", "success"]);
    expect(depStates.at(-1)?.environment_url).toBe("https://pr-4-web.example.com");

    const comments = calls.filter((c) => /\/issues\/(4\/comments$|comments\/900)/.test(c.path) && c.method !== "GET");
    expect(comments[0].method).toBe("POST");
    expect(comments.slice(1).every((c) => c.method === "PATCH")).toBe(true);
    expect((comments.at(-1)?.body as { body: string }).body).toContain("| web | Live | https://pr-4-web.example.com |");
  });

  it("comments once on the merged PR when production goes live", async () => {
    const { feedback, calls } = harness({
      routes: [["GET", /commits\/abcdef1234567\/pulls/, () => [{ number: 8, merged_at: "2026-01-01", merge_commit_sha: "abcdef1234567", base: { ref: "main" } }]]],
    });
    runDeploy(feedback, { status: "success", durationMs: 65_000 });
    await settle();
    const posts = calls.filter((c) => c.path === "/repos/acme/widget/issues/8/comments" && c.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0].body as { body: string }).body).toContain("**Live in production**");
    expect((posts[0].body as { body: string }).body).toContain("`abcdef1` | 1m 5s");
    expect(calls.find((c) => c.path === "/repos/acme/widget/deployments")?.body).toMatchObject({ environment: "production/web", production_environment: true });
  });

  it("reports a production failure with a log link on the merged PR", async () => {
    const { feedback, calls } = harness({
      routes: [["GET", /commits\/.*\/pulls/, () => [{ number: 8, merged_at: "2026-01-01", merge_commit_sha: "abcdef1234567", base: { ref: "main" } }]]],
    });
    runDeploy(feedback, { status: "failed", error: "Health check failed", durationMs: 1000 });
    await settle();
    const post = calls.find((c) => c.path === "/repos/acme/widget/issues/8/comments" && c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("Failed: Health check failed ([log](https://console.example.com/apps/app-1/deployments/dep-1))");
    expect(calls.filter((c) => c.path.includes("/statuses/abcdef")).at(-1)?.body).toMatchObject({ state: "failure" });
  });

  it("skips commit statuses on a manual redeploy of the branch", async () => {
    const { feedback, calls } = harness({ info: info({ trigger: "manual" }) });
    const t = feedback.trackDeploy("dep-1", { trigger: "manual" });
    t.stage("compose", "running");
    t.finish({ status: "success" });
    await settle();
    expect(calls.some((c) => c.path.includes("/statuses/abcdef"))).toBe(false);
    expect(calls.some((c) => c.path === "/repos/acme/widget/deployments")).toBe(true);
  });

  it("posts queued with a pinned SHA before the deploy starts", async () => {
    const { feedback, calls } = harness({ info: info({ trigger: "manual", pinnedSha: "1111111aaaa" }) });
    feedback.trackDeploy("dep-1", { trigger: "manual", gitSha: "1111111aaaa" });
    await settle();
    expect(calls.find((c) => c.path.includes("/statuses/1111111aaaa"))?.body).toMatchObject({ state: "pending", description: "Queued" });
    expect(calls.find((c) => c.path.endsWith("/deployments/500/statuses"))?.body).toMatchObject({ state: "queued" });
  });

  it("stays quiet when the app opted out", async () => {
    const { feedback, calls } = harness({ info: info({ enabled: false }) });
    runDeploy(feedback, { status: "success" });
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("blocks the app once on a missing permission and stops calling", async () => {
    let stored = false;
    const { feedback, calls, markBlocked } = harness({
      routes: [["POST", /\/statuses\//, () => { throw new GitHubPermissionError("statuses", "refused"); }]],
      deps: { loadInfo: async () => info({ enabled: !stored }) },
    });
    markBlocked.mockImplementation(async () => { stored = true; });
    runDeploy(feedback, { status: "success" });
    await settle();
    expect(markBlocked).toHaveBeenCalledTimes(1);
    expect(markBlocked).toHaveBeenCalledWith(["app-1"], "org-1", "statuses");
    expect(calls.filter((c) => c.path.includes("/statuses/"))).toHaveLength(1);
    expect(calls.some((c) => c.path === "/repos/acme/widget/deployments")).toBe(false);

    runDeploy(feedback, { status: "success" });
    await settle();
    expect(calls.filter((c) => c.path.includes("/statuses/"))).toHaveLength(1);
  });

  it("asks for a permission recheck when GitHub refuses a permission", async () => {
    const permissionDenied = vi.fn();
    const { feedback } = harness({
      routes: [["POST", /\/statuses\//, () => { throw new GitHubPermissionError("statuses", "refused"); }]],
      deps: { permissionDenied },
    });
    runDeploy(feedback, { status: "success" });
    await settle();
    expect(permissionDenied).toHaveBeenCalledWith("statuses");
  });

  it("a 403 from GitHub reaches the recheck through the real client", async () => {
    const fetchImpl = vi.fn(async () => new Response("Resource not accessible by integration", { status: 403 }));
    const permissionDenied = vi.fn();
    const { feedback } = harness({
      deps: { client: async () => githubClient("token", fetchImpl as unknown as typeof fetch), permissionDenied },
    });
    runDeploy(feedback, { status: "success" });
    await settle();
    expect(permissionDenied).toHaveBeenCalled();
  });

  it("does not recheck on a rate limit", async () => {
    const fetchImpl = vi.fn(async () => new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const permissionDenied = vi.fn();
    const { feedback } = harness({
      deps: { client: async () => githubClient("token", fetchImpl as unknown as typeof fetch), permissionDenied },
    });
    runDeploy(feedback, { status: "success" });
    await settle();
    expect(permissionDenied).not.toHaveBeenCalled();
  });

  it("never throws into the deploy path", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { feedback } = harness({
      deps: {
        loadInfo: async () => { throw new Error("db down"); },
      },
    });
    expect(() => runDeploy(feedback, { status: "failed", error: "x" })).not.toThrow();

    const broken = harness({ deps: { client: async () => { throw new Error("token mint failed"); } } });
    expect(() => runDeploy(broken.feedback, { status: "success" })).not.toThrow();

    const hostile = harness({ routes: [["POST", /.*/, () => { throw new Error("network"); }], ["GET", /.*/, () => { throw new Error("network"); }]] });
    expect(() => runDeploy(hostile.feedback, { status: "success" })).not.toThrow();
    await settle();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("marks the preview removed and its deployments inactive on close", async () => {
    const { feedback, calls } = harness({
      routes: [
        ["GET", /\/issues\/4\/comments/, () => [{ id: 33, body: MARKER, user: { type: "Bot" } }]],
        ["GET", /\/deployments\?per_page=100/, () => [
          { id: 71, environment: "preview/pr-4/web", payload: { vardo: { instance: "inst-1" } } },
          { id: 70, environment: "preview/pr-4/web", payload: { vardo: { instance: "inst-1" } } },
          { id: 72, environment: "preview/pr-4/api", payload: { vardo: { instance: "other-instance" } } },
        ]],
      ],
    });
    await feedback.previewRemoved("acme/widget", 4, ["org-1"]);
    await settle();
    const edit = calls.find((c) => c.method === "PATCH");
    expect(edit?.path).toBe("/repos/acme/widget/issues/comments/33");
    expect((edit?.body as { body: string }).body).toContain("**Preview removed**");
    const inactive = calls.filter((c) => c.path.endsWith("/statuses"));
    expect(inactive.map((c) => c.path)).toEqual(["/repos/acme/widget/deployments/71/statuses"]);
    expect(inactive[0].body).toMatchObject({ state: "inactive" });
  });

  it("doesn't create a comment just to say the preview was removed", async () => {
    const { feedback, calls } = harness();
    await feedback.previewRemoved("acme/widget", 4, ["org-1"]);
    await settle();
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/comments"))).toBe(false);
  });

  it("resets the PR comment to building on a new push", async () => {
    const shas = ["aaaaaaa1111", "bbbbbbb2222"];
    let n = 0;
    const { feedback, calls } = harness({
      info: info({ environment: "preview", pr: { repo: "acme/widget", number: 4 } }),
      deps: { readSha: async () => shas[n] },
    });
    runDeploy(feedback, { status: "success" });
    await settle();
    n = 1;
    const t = feedback.trackDeploy("dep-2", { trigger: "webhook" });
    t.stage("clone", "running");
    t.stage("compose", "running");
    await settle();
    const last = calls.filter((c) => c.method === "PATCH").at(-1)?.body as { body: string };
    expect(last.body).toContain("**Preview: building** at `bbbbbbb`");
  });
});

describe("deploy feedback under a rate limit", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("skips in-flight calls while backed off and delivers the final state after", async () => {
    let limited = true;
    const { feedback, calls } = harness({
      routes: [
        ["POST", /\/statuses\/abcdef/, (body) => {
          if (limited && (body as { state: string }).state === "pending") throw new GitHubRateLimitError(Date.now() + 30_000, "limited");
          return {};
        }],
        ["GET", /commits\/abcdef1234567\/pulls/, () => [{ number: 8, merged_at: "2026-01-01", merge_commit_sha: "abcdef1234567", base: { ref: "main" } }]],
      ],
    });
    runDeploy(feedback, { status: "success", durationMs: 2000 });
    await settle();
    // Only the call that met the limit reached GitHub.
    expect(calls).toHaveLength(1);

    limited = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(calls.filter((c) => c.path.includes("/statuses/abcdef")).map((c) => (c.body as { state: string }).state)).toEqual(["pending", "success"]);
    expect(calls.some((c) => c.method === "POST" && c.path === "/repos/acme/widget/deployments")).toBe(true);
    expect(calls.find((c) => c.path === "/repos/acme/widget/deployments/500/statuses")?.body).toMatchObject({ state: "success" });
    expect(calls.some((c) => c.method === "POST" && c.path === "/repos/acme/widget/issues/8/comments")).toBe(true);
  });

  it("backs off per installation", async () => {
    const { feedback, calls } = harness({
      routes: [["POST", /^\/repos\/acme\/widget\/statuses\//, () => { throw new GitHubRateLimitError(Date.now() + 60_000, "limited"); }]],
      deps: {
        loadInfo: async (id: string) => info({ deploymentId: id, repo: id === "dep-2" ? "acme/gadget" : "acme/widget", environment: "other" }),
        resolveInstallation: async (repo: string) => (repo === "acme/widget" ? 11 : 12),
      },
    });
    feedback.trackDeploy("dep-1", { trigger: "webhook" }).stage("compose", "running");
    await settle();
    feedback.trackDeploy("dep-2", { trigger: "webhook" }).stage("compose", "running");
    feedback.trackDeploy("dep-3", { trigger: "webhook" }).stage("compose", "running");
    await settle();
    expect(calls.map((c) => c.path.split("/statuses/")[0])).toEqual(["/repos/acme/widget", "/repos/acme/gadget"]);
  });
});
