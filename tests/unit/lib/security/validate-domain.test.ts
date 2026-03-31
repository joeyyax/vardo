import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertPublicDomain } from "@/lib/security/validate-domain";

// Mock dns.promises so tests don't make real network calls.
vi.mock("dns", () => ({
  promises: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

import { promises as dns } from "dns";

const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockResolve4.mockResolvedValue([]);
  mockResolve6.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("assertPublicDomain — blocked hostnames", () => {
  it("rejects localhost", async () => {
    await expect(assertPublicDomain("localhost")).rejects.toThrow(/SSRF/);
  });

  it("rejects localhost with port", async () => {
    await expect(assertPublicDomain("localhost:8080")).rejects.toThrow(/SSRF/);
  });

  it("rejects ip6-localhost", async () => {
    await expect(assertPublicDomain("ip6-localhost")).rejects.toThrow(/SSRF/);
  });
});

describe("assertPublicDomain — private IP literals", () => {
  it("rejects 127.0.0.1 (loopback)", async () => {
    await expect(assertPublicDomain("127.0.0.1")).rejects.toThrow(/SSRF/);
  });

  it("rejects 10.0.0.1 (private)", async () => {
    await expect(assertPublicDomain("10.0.0.1")).rejects.toThrow(/SSRF/);
  });

  it("rejects 172.16.0.1 (private)", async () => {
    await expect(assertPublicDomain("172.16.0.1")).rejects.toThrow(/SSRF/);
  });

  it("rejects 172.31.255.255 (private)", async () => {
    await expect(assertPublicDomain("172.31.255.255")).rejects.toThrow(/SSRF/);
  });

  it("rejects 192.168.1.1 (private)", async () => {
    await expect(assertPublicDomain("192.168.1.1")).rejects.toThrow(/SSRF/);
  });

  it("rejects 169.254.169.254 (AWS metadata)", async () => {
    await expect(assertPublicDomain("169.254.169.254")).rejects.toThrow(/SSRF/);
  });

  it("rejects ::1 (IPv6 loopback)", async () => {
    await expect(assertPublicDomain("::1")).rejects.toThrow(/SSRF/);
  });

  it("does not reject 172.32.0.1 (outside private range)", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    await expect(assertPublicDomain("172.32.0.1")).resolves.toBeUndefined();
  });
});

describe("assertPublicDomain — DNS resolution", () => {
  it("rejects a domain that resolves to a private IP", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.100"]);
    await expect(assertPublicDomain("internal.example.com")).rejects.toThrow(/SSRF/);
  });

  it("rejects a domain that resolves to the AWS metadata IP", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);
    await expect(assertPublicDomain("metadata.internal")).rejects.toThrow(/SSRF/);
  });

  it("allows a domain that resolves to a public IP", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]); // example.com
    await expect(assertPublicDomain("example.com")).resolves.toBeUndefined();
  });

  it("allows a domain when DNS resolution fails (network unreachable)", async () => {
    mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));
    // DNS failure should not block — the outbound fetch will fail naturally.
    await expect(assertPublicDomain("totally-unknown.example")).resolves.toBeUndefined();
  });
});
