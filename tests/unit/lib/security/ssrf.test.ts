import { describe, it, expect, vi, beforeEach } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({ lookup: lookupMock }));

const { parseIPv4, parseIPv6, blockedAddressReason, assertOutboundUrlAllowed, BlockedUrlError } =
  await import("@/lib/security/ssrf");

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("parseIPv4", () => {
  it("reads a dotted quad", () => {
    expect(parseIPv4("192.168.1.1")).toEqual([192, 168, 1, 1]);
  });

  it("rejects what only looks like one", () => {
    expect(parseIPv4("256.1.1.1")).toBeNull();
    expect(parseIPv4("1.2.3")).toBeNull();
    expect(parseIPv4("1.2.3.4.5")).toBeNull();
    expect(parseIPv4("0x7f.0.0.1")).toBeNull();
    expect(parseIPv4("example.com")).toBeNull();
  });
});

describe("parseIPv6", () => {
  it("expands ::", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("reads a full address", () => {
    expect(parseIPv6("2001:0db8:0000:0000:0000:0000:0000:0001")?.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
  });

  it("keeps a trailing dotted quad in the last four bytes", () => {
    expect(parseIPv6("::ffff:169.254.169.254")?.slice(12)).toEqual([169, 254, 169, 254]);
  });

  it("drops a zone id", () => {
    expect(parseIPv6("fe80::1%eth0")?.slice(0, 2)).toEqual([0xfe, 0x80]);
  });

  it("rejects nonsense", () => {
    expect(parseIPv6("::1::2")).toBeNull();
    expect(parseIPv6("gggg::1")).toBeNull();
    expect(parseIPv6("1.2.3.4")).toBeNull();
  });
});

describe("blockedAddressReason", () => {
  it("blocks the cloud metadata address", () => {
    expect(blockedAddressReason("169.254.169.254")).toMatch(/metadata/);
  });

  it("blocks loopback, private and CGNAT ranges", () => {
    expect(blockedAddressReason("127.0.0.1")).toMatch(/loopback/);
    expect(blockedAddressReason("10.0.0.19")).toMatch(/private/);
    expect(blockedAddressReason("172.16.0.1")).toMatch(/private/);
    expect(blockedAddressReason("172.31.255.255")).toMatch(/private/);
    expect(blockedAddressReason("192.168.1.1")).toMatch(/private/);
    expect(blockedAddressReason("100.64.0.1")).toMatch(/Tailscale/);
  });

  it("lets a public address through", () => {
    expect(blockedAddressReason("93.184.216.34")).toBeNull();
    expect(blockedAddressReason("8.8.8.8")).toBeNull();
    // 172.32 is outside 172.16/12 — the boundary a hand-rolled check gets wrong.
    expect(blockedAddressReason("172.32.0.1")).toBeNull();
    expect(blockedAddressReason("100.128.0.1")).toBeNull();
  });

  it("blocks IPv6 loopback and unique-local", () => {
    expect(blockedAddressReason("::1")).toMatch(/loopback/);
    expect(blockedAddressReason("fd00::1")).toMatch(/unique local/);
    expect(blockedAddressReason("fe80::1")).toMatch(/link-local/);
  });

  it("unwraps IPv4-mapped IPv6 — the standard way past this filter", () => {
    expect(blockedAddressReason("::ffff:169.254.169.254")).toMatch(/metadata/);
    expect(blockedAddressReason("::ffff:127.0.0.1")).toMatch(/loopback/);
    expect(blockedAddressReason("::ffff:10.0.0.1")).toMatch(/private/);
  });

  it("unwraps NAT64", () => {
    expect(blockedAddressReason("64:ff9b::169.254.169.254")).toMatch(/metadata/);
  });

  it("blocks the EC2 IPv6 metadata address via unique-local", () => {
    expect(blockedAddressReason("fd00:ec2::254")).toMatch(/unique local/);
  });

  it("refuses an address it cannot parse rather than allowing it", () => {
    expect(blockedAddressReason("not-an-address")).toMatch(/unrecognized/);
  });
});

describe("assertOutboundUrlAllowed", () => {
  it("allows a public https URL", async () => {
    await expect(assertOutboundUrlAllowed("https://example.com/hook")).resolves.toBeInstanceOf(URL);
  });

  it("refuses a non-HTTP scheme", async () => {
    await expect(assertOutboundUrlAllowed("file:///etc/passwd")).rejects.toThrow(BlockedUrlError);
    await expect(assertOutboundUrlAllowed("gopher://x/")).rejects.toThrow(/only http and https/);
  });

  it("refuses a literal private address without asking DNS", async () => {
    await expect(assertOutboundUrlAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/metadata/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a bracketed IPv6 literal", async () => {
    await expect(assertOutboundUrlAllowed("http://[::1]:8080/")).rejects.toThrow(/loopback/);
  });

  it("blocks a decimal-encoded host once resolved", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertOutboundUrlAllowed("http://2130706433/")).rejects.toThrow(/loopback/);
  });

  it("blocks a name that resolves into a private range — DNS rebinding", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.19", family: 4 }]);
    await expect(assertOutboundUrlAllowed("https://evil.example.com/")).rejects.toThrow(/private/);
  });

  it("checks every record, not just the first", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(assertOutboundUrlAllowed("https://split.example.com/")).rejects.toThrow(/metadata/);
  });

  it("refuses a host that will not resolve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertOutboundUrlAllowed("https://nope.invalid/")).rejects.toThrow(/Could not resolve/);
  });

  it("honors an allowlist entry, since reaching an internal service on purpose is legitimate", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.19", family: 4 }]);
    await expect(
      assertOutboundUrlAllowed("http://ntfy.internal/topic", { allowlist: ["ntfy.internal"] }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("matches an allowlist suffix entry only on the suffix", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.19", family: 4 }]);
    await expect(
      assertOutboundUrlAllowed("http://a.lab.internal/", { allowlist: [".lab.internal"] }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertOutboundUrlAllowed("http://notlab.internal/", { allowlist: [".lab.internal"] }),
    ).rejects.toThrow(/private/);
  });

  it("does not let an allowlist entry match a lookalike domain", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.19", family: 4 }]);
    await expect(
      assertOutboundUrlAllowed("http://ntfy.internal.evil.com/", { allowlist: ["ntfy.internal"] }),
    ).rejects.toThrow(/private/);
  });
});
