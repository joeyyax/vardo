import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, hkdfSync } from "crypto";

const { store, pinnedFetch } = vi.hoisted(() => ({
  store: new Map<string, { value: string; expiresAt: number }>(),
  pinnedFetch: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return "OK";
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry && entry.expiresAt > Date.now() ? entry.value : null;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  },
}));
vi.mock("@/lib/security/pinned-fetch", () => ({ pinnedFetch }));

import {
  answerReachToken,
  issueReachToken,
  probeReach,
  proxyFromHeaders,
  reachVerdict,
  signReachToken,
} from "@/lib/domains/reach";
import { BlockedUrlError } from "@/lib/security/ssrf";

const MASTER = "a".repeat(64);

function expectedSignature(token: string): string {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(MASTER, "hex"), "vardo-domain-reach/v1", "domain-reach", 32));
  return createHmac("sha256", key).update(token).digest("hex");
}

/** A response that echoes what the token endpoint would answer, read from the requested URL. */
async function vardoAnswer(url: URL, headers: Record<string, string> = {}): Promise<Response> {
  const token = url.pathname.split("/").pop()!;
  const body = await answerReachToken(token);
  return new Response(body ?? "Not found", { status: body ? 200 : 404, headers });
}

beforeEach(() => {
  store.clear();
  pinnedFetch.mockReset();
  vi.stubEnv("ENCRYPTION_MASTER_KEY", MASTER);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("token endpoint", () => {
  it("answers an issued token with its HMAC, never the token itself", async () => {
    const token = await issueReachToken();
    const body = await answerReachToken(token);
    expect(body).toBe(expectedSignature(token));
    expect(body).not.toContain(token);
  });

  it("refuses unknown and malformed tokens", async () => {
    expect(await answerReachToken("A".repeat(32))).toBeNull();
    expect(await answerReachToken("../../etc/passwd")).toBeNull();
    expect(await answerReachToken("<script>")).toBeNull();
  });

  it("stops answering after two minutes", async () => {
    vi.useFakeTimers();
    const token = await issueReachToken();
    vi.advanceTimersByTime(119_000);
    expect(await answerReachToken(token)).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(await answerReachToken(token)).toBeNull();
  });

  it("signs with a key derived from the master key", () => {
    const sig = signReachToken("t");
    vi.stubEnv("ENCRYPTION_MASTER_KEY", "b".repeat(64));
    expect(signReachToken("t")).not.toBe(sig);
    vi.stubEnv("ENCRYPTION_MASTER_KEY", "");
    expect(signReachToken("t")).toBeNull();
  });
});

describe("proxyFromHeaders", () => {
  it("names Cloudflare from cf-ray or its server header", () => {
    expect(proxyFromHeaders(new Headers({ "cf-ray": "abc-SJC" }))).toBe("cloudflare");
    expect(proxyFromHeaders(new Headers({ server: "cloudflare" }))).toBe("cloudflare");
  });

  it("calls other CDNs and load balancers a proxy", () => {
    expect(proxyFromHeaders(new Headers({ via: "1.1 varnish" }))).toBe("proxy");
    expect(proxyFromHeaders(new Headers({ "x-served-by": "cache-sjc1" }))).toBe("proxy");
    expect(proxyFromHeaders(new Headers({ "x-amz-cf-id": "x" }))).toBe("proxy");
  });

  it("sees no proxy on a direct answer", () => {
    expect(proxyFromHeaders(new Headers({ server: "nginx", "content-type": "text/plain" }))).toBeNull();
  });
});

describe("probeReach", () => {
  it("verifies over HTTPS and revokes the token", async () => {
    pinnedFetch.mockImplementation((url: URL) => vardoAnswer(url));
    expect(await probeReach("app.example.com")).toEqual({ outcome: "verified", proxy: null });
    const url = pinnedFetch.mock.calls[0][0] as URL;
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toMatch(/^\/\.well-known\/vardo\/[A-Za-z0-9_-]{32}$/);
    expect(store.size).toBe(0);
  });

  it("falls back to HTTP when HTTPS fails", async () => {
    pinnedFetch.mockImplementation((url: URL) =>
      url.protocol === "https:" ? Promise.reject(new Error("self-signed certificate")) : vardoAnswer(url),
    );
    expect((await probeReach("app.example.com")).outcome).toBe("verified");
    expect(pinnedFetch).toHaveBeenCalledTimes(2);
  });

  it("labels the proxy in front of a verified answer", async () => {
    pinnedFetch.mockImplementation((url: URL) => vardoAnswer(url, { "cf-ray": "abc", server: "cloudflare" }));
    expect(await probeReach("app.example.com")).toEqual({ outcome: "verified", proxy: "cloudflare" });
  });

  it("calls a server that answers without the token another server", async () => {
    pinnedFetch.mockResolvedValue(new Response("<html>someone else</html>", { status: 200 }));
    expect((await probeReach("app.example.com")).outcome).toBe("other-server");
    pinnedFetch.mockResolvedValue(new Response("", { status: 404 }));
    expect((await probeReach("app.example.com")).outcome).toBe("other-server");
  });

  it("rejects a server that reflects the token back", async () => {
    pinnedFetch.mockImplementation(async (url: URL) => new Response(url.pathname.split("/").pop(), { status: 200 }));
    expect((await probeReach("app.example.com")).outcome).toBe("other-server");
  });

  it("treats a proxy's origin error as not responding", async () => {
    pinnedFetch.mockResolvedValue(new Response("origin down", { status: 521, headers: { "cf-ray": "abc" } }));
    expect(await probeReach("app.example.com")).toEqual({ outcome: "no-response", proxy: "cloudflare" });
  });

  it("reports no response when both schemes fail", async () => {
    pinnedFetch.mockRejectedValue(new Error("ETIMEDOUT"));
    expect(await probeReach("app.example.com")).toEqual({ outcome: "no-response", proxy: null });
  });

  it("stops at an address the outbound policy refuses", async () => {
    pinnedFetch.mockRejectedValue(new BlockedUrlError("private"));
    expect((await probeReach("app.example.com")).outcome).toBe("blocked");
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("reachVerdict", () => {
  it("connects on a verified token whatever the records say", () => {
    expect(reachVerdict({ outcome: "verified", proxy: "proxy" }, false)).toEqual({ configured: true, verified: true, reachable: true });
  });

  it("never connects another server, even with records pointing here", () => {
    expect(reachVerdict({ outcome: "other-server", proxy: null }, true).configured).toBe(false);
  });

  it("falls back to records only when nothing answered", () => {
    expect(reachVerdict({ outcome: "no-response", proxy: null }, true)).toEqual({ configured: true, verified: false, reachable: false });
    expect(reachVerdict({ outcome: "blocked", proxy: null }, false).configured).toBe(false);
  });
});
