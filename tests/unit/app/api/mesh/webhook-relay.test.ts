// A relayed webhook is signed, opted into, deduped by delivery id, matched like a direct one and never relayed on.

import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach } from "vitest";

const GITHUB_SECRET = "whsec";
const TOKEN = "a".repeat(64);
const SHA = "0123456789abcdef0123456789abcdef01234567";

const state = vi.hoisted(() => ({
  redisKeys: new Set<string>(),
  peer: null as null | Record<string, unknown>,
  links: new Map<number, string[]>(),
  apps: [] as { id: string; name: string; displayName: string; organizationId: string; gitUrl: string; gitBranch: string; autoDeploy: boolean; isSystemManaged: boolean }[],
  peerUpdates: [] as Record<string, unknown>[],
  afterCallbacks: [] as (() => Promise<void>)[],
  githubSecret: "whsec" as string | null,
}));

const { requestDeploy, fanOutRelay, recordActivity, createPreview } = vi.hoisted(() => ({
  requestDeploy: vi.fn(),
  fanOutRelay: vi.fn(),
  recordActivity: vi.fn(),
  createPreview: vi.fn(),
}));

const dialect = new PgDialect();

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (cb: () => Promise<void>) => {
    state.afterCallbacks.push(cb);
  },
}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: async () => null }));
vi.mock("@/lib/redis", () => ({
  redis: {
    set: async (key: string) => {
      if (state.redisKeys.has(key)) return null;
      state.redisKeys.add(key);
      return "OK";
    },
  },
}));
vi.mock("@/lib/mesh/auth", () => ({
  requireMeshPeer: async () => {
    if (!state.peer) throw new Error("Unauthorized");
    return state.peer;
  },
}));
vi.mock("@/lib/system-settings", () => ({
  getGitHubAppConfig: async () => (state.githubSecret ? { webhookSecret: state.githubSecret } : null),
  getInstanceDisplayName: async () => "edge-1",
}));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy }));
vi.mock("@/lib/docker/preview", () => ({ createPreview, destroyPreview: vi.fn() }));
vi.mock("@/lib/docker/self-preview", () => ({
  getSystemManagedApp: vi.fn(),
  createVardoPreview: vi.fn(),
  destroyVardoPreview: vi.fn(),
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false, isFeatureEnabledAsync: async () => true }));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/mesh/webhook-relay-send", () => ({ fanOutRelay }));
vi.mock("@/lib/git-integration/org-installations", () => ({
  orgsForInstallation: async (id: number) => state.links.get(id) ?? [],
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findMany: async ({ where }: { where: SQL }) => {
          const { params } = dialect.sqlToQuery(where);
          return state.apps.filter(
            (a) => params.includes(a.gitUrl) && a.autoDeploy && params.includes(a.organizationId),
          );
        },
      },
      organizations: { findMany: async () => [{ id: "org-a" }, { id: "org-b" }] },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.peerUpdates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const relayRoute = await import("@/app/api/v1/mesh/webhook-relay/route");
const githubRoute = await import("@/app/api/v1/github/webhook/route");
const { signMeshRequest } = await import("@/lib/mesh/signing");
const { toRelayEvent, eventFromGithub } = await import("@/lib/git-integration/webhook-event");

const PATH = "/api/v1/mesh/webhook-relay";

function pushBody(deliveryInstall = 2) {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: SHA,
    repository: { full_name: "acme/site" },
    head_commit: { message: "secret plans" },
    pusher: { name: "dev" },
    installation: { id: deliveryInstall },
  });
}

function relayOf(body: string, deliveryId = "d-1", withGithub = false) {
  const event = eventFromGithub("push", JSON.parse(body), deliveryId)!;
  const signature = "sha256=" + createHmac("sha256", GITHUB_SECRET).update(body).digest("hex");
  return toRelayEvent({ ...event, deliveryId }, withGithub ? { body, signature } : undefined);
}

function postRelay(payload: unknown, opts: { sign?: boolean; nonce?: string; token?: string } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (opts.sign !== false) {
    Object.assign(headers, signMeshRequest({ token: opts.token ?? TOKEN, method: "POST", path: PATH, body, nonce: opts.nonce }));
  }
  return relayRoute.POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", body, headers }));
}

function postGithub(body: string, deliveryId: string) {
  const signature = "sha256=" + createHmac("sha256", GITHUB_SECRET).update(body).digest("hex");
  return githubRoute.POST(
    new NextRequest("http://localhost/api/v1/github/webhook", {
      method: "POST",
      body,
      headers: { "x-github-event": "push", "x-hub-signature-256": signature, "x-github-delivery": deliveryId },
    }),
  );
}

const app = (id: string, organizationId: string, gitBranch = "main") => ({
  id,
  name: id,
  displayName: id,
  organizationId,
  gitUrl: "https://github.com/acme/site.git",
  gitBranch,
  autoDeploy: true,
  isSystemManaged: false,
});

beforeEach(() => {
  state.redisKeys.clear();
  state.links.clear();
  state.links.set(2, ["org-a"]);
  state.peerUpdates.length = 0;
  state.afterCallbacks.length = 0;
  state.githubSecret = GITHUB_SECRET;
  state.apps.length = 0;
  state.apps.push(app("site-a", "org-a"), app("site-b", "org-b"), app("site-a-staging", "org-a", "staging"));
  state.peer = {
    id: "peer-hub",
    name: "hub",
    instanceId: "inst-hub",
    organizationId: "org-a",
    acceptWebhookRelay: true,
    tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  };
  requestDeploy.mockReset();
  requestDeploy.mockResolvedValue({ deploymentId: "d", success: true });
  fanOutRelay.mockReset();
  recordActivity.mockReset();
  recordActivity.mockResolvedValue(undefined);
  createPreview.mockReset();
});

describe("relay signing", () => {
  it("refuses an unsigned relay", async () => {
    const res = await postRelay(relayOf(pushBody()), { sign: false });
    expect(res.status).toBe(401);
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it("refuses a relay signed with another token", async () => {
    const res = await postRelay(relayOf(pushBody()), { token: "b".repeat(64) });
    expect(res.status).toBe(401);
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it("refuses a replayed nonce", async () => {
    const nonce = "f".repeat(32);
    expect((await postRelay(relayOf(pushBody(), "d-1"), { nonce })).status).toBe(202);
    const replay = await postRelay(relayOf(pushBody(), "d-2"), { nonce });
    expect(replay.status).toBe(401);
    expect(requestDeploy).toHaveBeenCalledTimes(1);
  });
});

describe("relay opt-in", () => {
  it("refuses a peer this instance hasn't accepted relays from", async () => {
    state.peer!.acceptWebhookRelay = false;
    const res = await postRelay(relayOf(pushBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("doesn't accept relayed webhooks from hub");
    expect(requestDeploy).not.toHaveBeenCalled();
    expect(state.peerUpdates.at(-1)?.lastRelayReceivedStatus).toMatch(/^refused/);
  });

  it("refuses an unknown peer", async () => {
    state.peer = null;
    expect((await postRelay(relayOf(pushBody()))).status).toBe(401);
  });
});

describe("delivery dedupe", () => {
  it("deploys a relayed delivery once", async () => {
    await postRelay(relayOf(pushBody(), "d-9"));
    const again = await postRelay(relayOf(pushBody(), "d-9"));
    expect((await again.json()).skipped).toBe("duplicate delivery");
    expect(requestDeploy).toHaveBeenCalledTimes(1);
  });

  it("skips a relay of a delivery that already arrived from GitHub", async () => {
    await postGithub(pushBody(), "d-7");
    expect(requestDeploy).toHaveBeenCalledTimes(1);
    const relayed = await postRelay(relayOf(pushBody(), "d-7"));
    expect((await relayed.json()).skipped).toBe("duplicate delivery");
    expect(requestDeploy).toHaveBeenCalledTimes(1);
  });

  it("skips a GitHub delivery that already arrived by relay", async () => {
    await postRelay(relayOf(pushBody(), "d-8"));
    const direct = await postGithub(pushBody(), "d-8");
    expect((await direct.json()).skipped).toBe("duplicate delivery");
    expect(requestDeploy).toHaveBeenCalledTimes(1);
  });
});

describe("matching parity", () => {
  it("deploys the same apps a direct webhook would, with the relay trigger", async () => {
    await postGithub(pushBody(), "direct-1");
    const direct = requestDeploy.mock.calls.map(([o]) => ({ appId: o.appId, organizationId: o.organizationId, trigger: o.trigger }));
    requestDeploy.mockClear();
    state.redisKeys.clear();

    await postRelay(relayOf(pushBody(), "relay-1"));
    const relayed = requestDeploy.mock.calls.map(([o]) => ({ appId: o.appId, organizationId: o.organizationId, trigger: o.trigger }));

    expect(direct).toEqual([{ appId: "site-a", organizationId: "org-a", trigger: "webhook" }]);
    expect(relayed).toEqual([{ appId: "site-a", organizationId: "org-a", trigger: "relay" }]);
  });

  it("reaches every org when the peer isn't bound to one", async () => {
    state.peer!.organizationId = null;
    await postRelay(relayOf(pushBody()));
    expect(requestDeploy.mock.calls.map(([o]) => o.appId).sort()).toEqual(["site-a", "site-b"]);
  });

  it("records the relay on the deployed app", async () => {
    await postRelay(relayOf(pushBody()));
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mesh.webhook_relay_received", appId: "site-a", organizationId: "org-a" }),
    );
    expect(state.peerUpdates.at(-1)?.lastRelayReceivedStatus).toBe("deploying site-a");
  });

  it("refuses a fork pull request like a direct webhook", async () => {
    const pr = JSON.stringify({
      action: "opened",
      installation: { id: 2 },
      repository: { full_name: "acme/site" },
      pull_request: {
        number: 4,
        head: { ref: "feat", sha: SHA, repo: { full_name: "stranger/site", fork: true } },
        user: { login: "stranger" },
      },
    });
    const event = eventFromGithub("pull_request", JSON.parse(pr), "pr-1")!;
    const res = await postRelay(toRelayEvent({ ...event, deliveryId: "pr-1" }));
    expect((await res.json()).skipped).toMatch(/fork/i);
    expect(createPreview).not.toHaveBeenCalled();
  });
});

describe("one hop", () => {
  it("a direct delivery is relayed after the response", async () => {
    await postGithub(pushBody(), "d-5");
    for (const cb of state.afterCallbacks) await cb();
    expect(fanOutRelay).toHaveBeenCalledTimes(1);
    expect(fanOutRelay.mock.calls[0][0]).toMatchObject({ relayed: true, deliveryId: "d-5", repoFullName: "acme/site" });
    expect(fanOutRelay.mock.calls[0][1]).toEqual(["org-a"]);
  });

  it("a relayed delivery is never relayed again", async () => {
    await postRelay(relayOf(pushBody(), "d-6"));
    for (const cb of state.afterCallbacks) await cb();
    expect(fanOutRelay).not.toHaveBeenCalled();
  });

  it("refuses a relay that isn't marked as relayed", async () => {
    const res = await postRelay({ ...relayOf(pushBody()), relayed: false });
    expect(res.status).toBe(400);
  });
});

describe("GitHub re-verification", () => {
  it("accepts a relay whose GitHub body verifies and agrees", async () => {
    const res = await postRelay(relayOf(pushBody(), "g-1", true));
    expect(res.status).toBe(202);
    expect(state.peerUpdates.at(-1)?.lastRelayReceivedStatus).toContain("GitHub signature verified");
  });

  it("refuses a relay that disagrees with GitHub's signed body", async () => {
    const relay = { ...relayOf(pushBody(), "g-2", true), branch: "staging", ref: "refs/heads/staging" };
    const res = await postRelay(relay);
    expect(res.status).toBe(400);
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it("falls back to the summary when this instance has a different secret", async () => {
    state.githubSecret = "other";
    const res = await postRelay(relayOf(pushBody(), "g-3", true));
    expect(res.status).toBe(202);
    expect(requestDeploy).toHaveBeenCalledTimes(1);
  });
});
