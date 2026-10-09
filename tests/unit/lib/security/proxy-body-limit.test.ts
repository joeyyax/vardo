// A body past the proxy limit is refused, never passed on cut off; the import route sits outside the proxy.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/lib/auth/api-token", () => ({ findApiToken: vi.fn() }));

import { proxy, config } from "@/proxy";
import { PROXY_BODY_LIMIT_BYTES } from "@/lib/security/body-limit";
import nextConfig from "@/next.config";

const url = "https://vardo.example.com/api/v1/admin/config/import";
const post = (headers: Record<string, string>) =>
  new NextRequest(url, { method: "POST", headers: { "x-forwarded-for": "10.9.0.1", ...headers } });

describe("proxy body limit", () => {
  it("answers 413 with a JSON error past the limit", async () => {
    const res = await proxy(post({ "content-length": String(PROXY_BODY_LIMIT_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: expect.stringContaining("larger than") });
  });

  it("lets a body at the limit through", async () => {
    const res = await proxy(post({ "content-length": String(PROXY_BODY_LIMIT_BYTES) }));
    expect(res.status).toBe(200);
  });

  it("answers 411 for a chunked body it can't measure", async () => {
    const res = await proxy(post({ "transfer-encoding": "chunked" }));
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("raises Next's buffer to the same limit", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(PROXY_BODY_LIMIT_BYTES);
  });

  it("keeps the upload route out of the proxy so its body is never buffered", () => {
    const path = "/api/v1/organizations/o/apps/a/import";
    expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/v1/admin/config/import" })).toBe(true);
  });
});
