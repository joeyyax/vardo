import { describe, expect, it } from "vitest";
import { isCloudflareIp } from "@/lib/cloudflare-ips";

describe("isCloudflareIp", () => {
  it("matches addresses in ranges below 128.0.0.0", () => {
    expect(isCloudflareIp("104.21.26.33")).toBe(true);
    expect(isCloudflareIp("103.21.244.1")).toBe(true);
  });

  it("matches addresses in ranges at or above 128.0.0.0", () => {
    expect(isCloudflareIp("172.67.135.85")).toBe(true);
    expect(isCloudflareIp("162.159.1.1")).toBe(true);
    expect(isCloudflareIp("198.41.200.1")).toBe(true);
  });

  it("rejects addresses outside Cloudflare", () => {
    expect(isCloudflareIp("203.0.113.10")).toBe(false);
    expect(isCloudflareIp("172.80.0.1")).toBe(false);
  });
});
