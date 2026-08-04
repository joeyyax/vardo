import { describe, it, expect, vi, beforeEach } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({ lookup: lookupMock }));

const { safeFetch } = await import("@/lib/security/safe-fetch");
const { BlockedUrlError } = await import("@/lib/security/ssrf");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/** A redirect response the way undici hands one back in manual mode. */
function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock.mockReset();
});

describe("safeFetch", () => {
  it("passes a plain request through", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await safeFetch("https://example.com/hook", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never lets fetch follow redirects itself", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await safeFetch("https://example.com/");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses the request outright when the first URL is blocked", async () => {
    await expect(safeFetch("http://169.254.169.254/")).rejects.toThrow(BlockedUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a redirect into link-local — the bypass a one-time check misses", async () => {
    fetchMock.mockResolvedValueOnce(redirect(302, "http://169.254.169.254/latest/meta-data/"));
    await expect(safeFetch("https://example.com/")).rejects.toThrow(/metadata/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to a name that resolves privately", async () => {
    fetchMock.mockResolvedValueOnce(redirect(301, "https://internal.example.com/"));
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.19", family: 4 }]);
    await expect(safeFetch("https://example.com/")).rejects.toThrow(/private/);
  });

  it("follows a permitted redirect", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(302, "https://elsewhere.example.com/x"))
      .mockResolvedValueOnce(new Response("landed", { status: 200 }));
    const res = await safeFetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("landed");
  });

  it("resolves a relative redirect against the current URL", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(302, "/next"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await safeFetch("https://example.com/first");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://example.com/next");
  });

  it("drops the signature when a redirect changes host", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(307, "https://other.example.com/"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await safeFetch("https://example.com/", {
      method: "POST",
      body: "{}",
      headers: { "X-Signature-256": "sha256=secret", "Content-Type": "application/json" },
    });
    const forwarded = fetchMock.mock.calls[1][1].headers as Headers;
    expect(forwarded.get("x-signature-256")).toBeNull();
    expect(forwarded.get("content-type")).toBe("application/json");
  });

  it("keeps the signature on a same-host redirect", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(307, "https://example.com/moved"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await safeFetch("https://example.com/", {
      method: "POST",
      headers: { "X-Signature-256": "sha256=secret" },
    });
    const forwarded = fetchMock.mock.calls[1][1].headers as Headers;
    expect(forwarded.get("x-signature-256")).toBe("sha256=secret");
  });

  it("turns a redirected POST into a GET for 303, dropping the body", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(303, "https://example.com/done"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await safeFetch("https://example.com/", { method: "POST", body: "{}" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "GET", body: undefined });
  });

  it("keeps method and body across a 307", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(307, "https://example.com/done"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await safeFetch("https://example.com/", { method: "POST", body: "{}" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("gives up rather than looping forever", async () => {
    fetchMock.mockResolvedValue(redirect(302, "https://example.com/again"));
    await expect(safeFetch("https://example.com/", { maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns a 3xx that carries no Location rather than treating it as a redirect", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    const res = await safeFetch("https://example.com/");
    expect(res.status).toBe(304);
  });
});
