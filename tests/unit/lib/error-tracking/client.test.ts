// ---------------------------------------------------------------------------
// GlitchTip client: what a failing API does to the caller and to the log.
// GlitchTip is optional infrastructure, so every failure degrades quietly.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { warn, error, getErrorTrackingConfig } = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  getErrorTrackingConfig: vi.fn(),
}));

vi.mock("@/lib/logger", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn, error, child: () => log };
  return { logger: log };
});
vi.mock("@/lib/system-settings", () => ({ getErrorTrackingConfig }));

const ORG = { id: 1, slug: "vardo", name: "Vardo" };

type Route = (url: string, init?: RequestInit) => Response;

/** Install a fetch stub and load a fresh client, past the module-level caches. */
async function loadClient(route: Route) {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => Promise.resolve(route(String(input), init))),
  );
  return import("@/lib/error-tracking/client");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The Django error page GlitchTip serves when its database is unreachable. */
function djangoError(): Response {
  return new Response(
    `<!doctype html>\n<html lang="en">\n<head>\n  <title>Server Error (500)</title>\n</head>\n<body>\n  <h1>Server Error (500)</h1><p></p>\n</body>\n</html>`,
    { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** Happy-path routing: an existing project with one key. */
function healthy(url: string): Response {
  if (url.includes("/organizations/") && url.endsWith("/projects/")) {
    return json([{ id: 7, slug: "blog", name: "blog" }]);
  }
  if (url.endsWith("/api/0/organizations/")) return json([ORG]);
  if (url.includes("/keys/")) return json([{ dsn: { public: "https://key@glitchtip/7", secret: "s" } }]);
  if (url.endsWith("/api/0/")) return json({});
  return json({ detail: "not routed" }, 404);
}

beforeEach(() => {
  vi.clearAllMocks();
  getErrorTrackingConfig.mockResolvedValue({
    url: "http://glitchtip:8000",
    apiToken: "token",
    publicUrl: "http://glitchtip:8000",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureProjectDSN", () => {
  it("returns the DSN of an existing project", async () => {
    const { ensureProjectDSN } = await loadClient(healthy);

    await expect(ensureProjectDSN("blog")).resolves.toBe("https://key@glitchtip/7");
    expect(warn).not.toHaveBeenCalled();
  });

  it("creates the project when GlitchTip has no match for the app name", async () => {
    const posted: string[] = [];
    const { ensureProjectDSN } = await loadClient((url, init) => {
      if (init?.method === "POST") posted.push(url);
      if (url.endsWith("/api/0/organizations/")) return json([ORG]);
      if (url.includes("/organizations/") && url.endsWith("/projects/")) return json([]);
      if (url.endsWith("/teams/")) return json([{ slug: "default" }]);
      if (url.includes("/teams/vardo/default/projects/")) return json({ id: 9, slug: "plex", name: "plex" });
      if (url.includes("/keys/")) return json([{ dsn: { public: "https://key@glitchtip/9", secret: "s" } }]);
      return json({ detail: "not routed" }, 404);
    });

    await expect(ensureProjectDSN("plex")).resolves.toBe("https://key@glitchtip/9");
    expect(posted).toEqual(["http://glitchtip:8000/api/0/teams/vardo/default/projects/"]);
  });

  it("describes a non-JSON error body by status and content type instead of dumping it", async () => {
    const { ensureProjectDSN } = await loadClient(djangoError);

    await expect(ensureProjectDSN("vardo-postgres")).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const [prefix, detail] = warn.mock.calls[0];
    expect(prefix).toBe('Skipping DSN for "vardo-postgres":');
    expect(detail).toBe("GlitchTip API 500 (text/html)");
  });

  it("logs a single line with no stack trace and no markup", async () => {
    const { ensureProjectDSN } = await loadClient(djangoError);

    await ensureProjectDSN("vardo-redis");

    const logged = warn.mock.calls[0].join(" ");
    expect(logged).not.toContain("<!doctype");
    expect(logged).not.toContain("<html");
    expect(logged).not.toContain("    at ");
    expect(logged.split("\n")).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps a JSON error body, which is already short and useful", async () => {
    const { ensureProjectDSN } = await loadClient(() => json({ detail: "Unauthorized" }, 401));

    await ensureProjectDSN("blog");

    expect(warn.mock.calls[0][1]).toBe('GlitchTip API 401: {"detail":"Unauthorized"}');
  });

  it("truncates an overlong JSON error body", async () => {
    const { ensureProjectDSN } = await loadClient(() => json({ detail: "x".repeat(500) }, 400));

    await ensureProjectDSN("blog");

    const detail = String(warn.mock.calls[0][1]);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail.length).toBeLessThan(240);
  });

  it("reports a 200 that is not JSON rather than throwing a parse error", async () => {
    const { ensureProjectDSN } = await loadClient(
      () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    await expect(ensureProjectDSN("blog")).resolves.toBeNull();
    expect(warn.mock.calls[0][1]).toBe("GlitchTip API 200: expected JSON, got text/html");
  });
});

describe("listIssues", () => {
  it("returns the project's issues", async () => {
    const { listIssues } = await loadClient((url) => {
      if (url.includes("/issues/")) return json([{ id: 1, title: "boom", permalink: null }]);
      return healthy(url);
    });

    await expect(listIssues("blog")).resolves.toHaveLength(1);
  });

  it("returns empty when the organization lookup fails", async () => {
    const { listIssues } = await loadClient(djangoError);

    await expect(listIssues("blog")).resolves.toEqual([]);
  });
});

describe("isGlitchTipAvailable", () => {
  it("is false when GlitchTip cannot be reached", async () => {
    const { isGlitchTipAvailable } = await loadClient(() => {
      throw new Error("ECONNREFUSED");
    });

    await expect(isGlitchTipAvailable()).resolves.toBe(false);
  });
});
