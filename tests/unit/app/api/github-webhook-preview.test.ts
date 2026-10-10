import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// GitHub times a webhook out after ten seconds. The handler awaited the whole
// preview create and deploy, minutes of work, before answering.

const { createPreviewMock, destroyPreviewMock, afterCallbacks } = vi.hoisted(() => ({
  createPreviewMock: vi.fn(),
  destroyPreviewMock: vi.fn(),
  afterCallbacks: [] as (() => Promise<void>)[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (cb: () => Promise<void>) => {
    afterCallbacks.push(cb);
  },
}));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/system-settings", () => ({
  getGitHubAppConfig: vi.fn().mockResolvedValue({ webhookSecret: "s3cret" }),
}));
vi.mock("@/lib/config/features", () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(false),
  isFeatureEnabledAsync: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/docker/preview", () => ({
  createPreview: createPreviewMock,
  destroyPreview: destroyPreviewMock,
}));
vi.mock("@/lib/docker/self-preview", () => ({
  getSystemManagedApp: vi.fn(),
  createVardoPreview: vi.fn(),
  destroyVardoPreview: vi.fn(),
}));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { query: {} } }));

import { POST } from "@/app/api/v1/github/webhook/route";
import { NextRequest } from "next/server";
import { isFeatureEnabled, isFeatureEnabledAsync } from "@/lib/config/features";
import { getSystemManagedApp, createVardoPreview, destroyVardoPreview } from "@/lib/docker/self-preview";

function prEvent(action: string) {
  const body = JSON.stringify({
    action,
    repository: { full_name: "acme/tools-api" },
    pull_request: {
      number: 25,
      html_url: "https://github.com/acme/tools-api/pull/25",
      head: { ref: "feat/x", repo: { full_name: "acme/tools-api", fork: false } },
      user: { login: "acme-dev" },
    },
  });
  const signature = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  return new NextRequest("http://localhost/api/v1/github/webhook", {
    method: "POST",
    body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature },
  });
}

const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  // A create that never finishes inside the request.
  createPreviewMock.mockReturnValue(new Promise(() => {}));
  destroyPreviewMock.mockReturnValue(new Promise(() => {}));
});

describe("GitHub pull_request webhook", () => {
  it("answers 202 before the preview create finishes", async () => {
    const res = await within(POST(prEvent("opened"), {}), 500);

    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(202);
  });

  it("runs the create after the response", async () => {
    await within(POST(prEvent("opened"), {}), 500);
    expect(afterCallbacks).toHaveLength(1);

    void afterCallbacks[0]();
    expect(createPreviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: "acme/tools-api", prNumber: 25, branch: "feat/x" }),
    );
  });

  it("answers 202 before the teardown finishes", async () => {
    const res = await within(POST(prEvent("closed"), {}), 500);

    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(202);
    void afterCallbacks[0]();
    expect(destroyPreviewMock).toHaveBeenCalledWith("acme/tools-api", 25);
  });
});

describe("GitHub pull_request webhook with previews off", () => {
  beforeEach(() => {
    vi.mocked(isFeatureEnabledAsync).mockResolvedValue(false);
  });

  it.each(["opened", "reopened", "synchronize"])("creates nothing on %s", async (action) => {
    const res = (await POST(prEvent(action), {})) as Response;

    expect(await res.json()).toMatchObject({ skipped: "previews disabled" });
    expect(afterCallbacks).toHaveLength(0);
    expect(createPreviewMock).not.toHaveBeenCalled();
  });

  it("still tears down an existing preview on close", async () => {
    await POST(prEvent("closed"), {});
    void afterCallbacks[0]();

    expect(destroyPreviewMock).toHaveBeenCalledWith("acme/tools-api", 25);
  });

  it("never builds a Vardo self-preview", async () => {
    vi.mocked(isFeatureEnabled).mockReturnValue(true);
    vi.mocked(getSystemManagedApp).mockResolvedValue({ id: "vardo" } as never);

    const res = (await POST(prEvent("opened"), {})) as Response;

    expect(await res.json()).toMatchObject({ skipped: "previews disabled" });
    expect(createVardoPreview).not.toHaveBeenCalled();
    expect(destroyVardoPreview).not.toHaveBeenCalled();
    vi.mocked(isFeatureEnabled).mockReturnValue(false);
  });
});
