// URL jobs: retries with backoff, per-attempt timeout, expected status, redaction and the SSRF block.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/security/outbound-policy", () => ({ getOutboundPolicy: async () => ({ allowlist: ["allowed.example.com"] }) }));

const { runUrlRequest, cronOutboundPolicy, BODY_SNIPPET_BYTES } = await import("@/lib/cron/http");
const { BlockedUrlError } = await import("@/lib/security/ssrf");
const { parseExpectedStatus, statusMatches } = await import("@/lib/cron/url-options");

const URL = "https://site.example.com/wp-cron.php";

function respond(status: number, body = "", statusText = "") {
  return new Response(status === 204 || status === 304 ? null : body, { status, statusText });
}

const noSleep = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
});

describe("runUrlRequest", () => {
  it("succeeds on a 2xx and records status, attempts and the body", async () => {
    const fetch = vi.fn(async () => respond(200, "ok"));
    const r = await runUrlRequest({ url: URL }, {}, { fetch, sleep: noSleep });
    expect(r).toMatchObject({ success: true, httpStatus: 200, attempts: 1 });
    expect(r.log).toContain("GET https://site.example.com/wp-cron.php → 200");
    expect(r.log).toContain("ok");
  });

  it("sends the method, headers and the outbound policy", async () => {
    const fetch = vi.fn(async (_url: string, _init: { method?: string; headers?: unknown; policy?: unknown }) => respond(200));
    const policy = { allowlist: ["x.example.com"] };
    await runUrlRequest({ url: URL, method: "POST", headers: [{ name: "X-Token", value: "secret-value" }] }, policy, { fetch, sleep: noSleep });
    const init = fetch.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "X-Token": "secret-value" });
    expect(init.policy).toBe(policy);
  });

  it("fails on a status outside the expected set", async () => {
    const fetch = vi.fn(async () => respond(301));
    const r = await runUrlRequest({ url: URL }, {}, { fetch, sleep: noSleep });
    expect(r.success).toBe(false);
    expect(r.log).toContain("expected 2xx");
  });

  it("honors a custom expected status", async () => {
    const fetch = vi.fn(async () => respond(301));
    expect((await runUrlRequest({ url: URL, expectedStatus: "200,301" }, {}, { fetch })).success).toBe(true);
    expect((await runUrlRequest({ url: URL, expectedStatus: "3xx" }, {}, { fetch })).success).toBe(true);
  });

  it("retries failures with exponential backoff and stops on success", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(500))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(respond(200, "done"));
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await runUrlRequest({ url: URL, retries: 3 }, {}, { fetch, sleep, backoffMs: 100 });
    expect(r).toMatchObject({ success: true, attempts: 3, httpStatus: 200 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    expect(r.log).toContain("attempt 1 of 4");
    expect(r.log).toContain("socket hang up");
  });

  it("gives up after the last retry", async () => {
    const fetch = vi.fn(async () => respond(503));
    const r = await runUrlRequest({ url: URL, retries: 2 }, {}, { fetch, sleep: noSleep });
    expect(r).toMatchObject({ success: false, attempts: 3, httpStatus: 503 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("caps retries at 3", async () => {
    const fetch = vi.fn(async () => respond(500));
    const r = await runUrlRequest({ url: URL, retries: 10 }, {}, { fetch, sleep: noSleep });
    expect(r.attempts).toBe(4);
  });

  it("times out an attempt that hangs", async () => {
    const fetch = vi.fn(
      (_url: string, init: { signal?: AbortSignal | null }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const r = await runUrlRequest({ url: URL, timeoutMs: 20 }, {}, { fetch, sleep: noSleep });
    expect(r.success).toBe(false);
    expect(r.log).toContain("timed out after 20ms");
  });

  it("doesn't retry a request the policy refuses", async () => {
    const fetch = vi.fn(async () => {
      throw new BlockedUrlError("Refusing to reach 10.0.0.5 — private network");
    });
    const r = await runUrlRequest({ url: "http://10.0.0.5/", retries: 3 }, {}, { fetch, sleep: noSleep });
    expect(r.success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.log).toContain("private network");
  });

  it("blocks loopback and private targets through the real safe fetch", async () => {
    for (const target of ["http://127.0.0.1:3000/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
      const r = await runUrlRequest({ url: target, retries: 2 }, {}, { sleep: noSleep });
      expect(r.success).toBe(false);
      expect(r.attempts).toBe(1);
      expect(r.log).toMatch(/Refusing/);
    }
  });

  it("redacts header values and URL credentials from the log", async () => {
    const fetch = vi.fn(async () => respond(500, "echo: Bearer abcdefghijklmnop key=hunter2-secret"));
    const r = await runUrlRequest(
      { url: "https://user:pa55word@site.example.com/cron", headers: [{ name: "X-Key", value: "hunter2-secret" }] },
      {},
      { fetch, sleep: noSleep },
    );
    expect(r.log).not.toContain("hunter2-secret");
    expect(r.log).not.toContain("pa55word");
    expect(r.log).not.toContain("abcdefghijklmnop");
    expect(r.target).not.toContain("pa55word");
  });

  it("keeps only a snippet of a large body", async () => {
    const fetch = vi.fn(async () => respond(200, "x".repeat(BODY_SNIPPET_BYTES * 4)));
    const r = await runUrlRequest({ url: URL }, {}, { fetch, sleep: noSleep });
    expect(r.log.length).toBeLessThan(BODY_SNIPPET_BYTES + 300);
    expect(r.log).toContain("(truncated)");
  });

  it("reads no body on HEAD", async () => {
    const fetch = vi.fn(async () => respond(200, "ignored"));
    const r = await runUrlRequest({ url: URL, method: "HEAD" }, {}, { fetch, sleep: noSleep });
    expect(r.log).not.toContain("ignored");
  });
});

describe("cronOutboundPolicy", () => {
  it("is the instance allowlist for an untrusted org", async () => {
    dbMock.query.organizations.findFirst.mockResolvedValue({ trusted: false });
    expect(await cronOutboundPolicy("o1", "http://10.0.0.5/cron")).toEqual({ allowlist: ["allowed.example.com"] });
  });

  it("adds only the job's own host for a trusted org", async () => {
    dbMock.query.organizations.findFirst.mockResolvedValue({ trusted: true });
    expect(await cronOutboundPolicy("o1", "http://internal.lan:8080/cron")).toEqual({
      allowlist: ["allowed.example.com", "internal.lan"],
    });
  });
});

describe("expected status", () => {
  it.each([
    ["2xx", 204, true],
    ["2xx", 301, false],
    ["200,204", 204, true],
    ["200-299", 250, true],
    ["404", 404, true],
  ])("%s with %i is %s", (spec, status, ok) => {
    expect(statusMatches(spec, status)).toBe(ok);
  });

  it("defaults to 2xx", () => {
    expect(statusMatches(null, 200)).toBe(true);
    expect(statusMatches("", 500)).toBe(false);
  });

  it.each(["abc", "6xx", "299-200", "99", ""])("rejects %j", (spec) => {
    expect(parseExpectedStatus(spec)).toBeNull();
  });
});
