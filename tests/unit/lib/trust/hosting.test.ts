import { describe, expect, it } from "vitest";
import { hetznerLocation, judgeProviderCert, manualHosting, parseHetznerMetadata } from "@/lib/trust/hosting";

describe("hetznerLocation", () => {
  it("reads the location code from a zone", () => {
    expect(hetznerLocation("hil-dc1")).toBe("hil");
    expect(hetznerLocation("fsn1-dc14")).toBe("fsn1");
    expect(hetznerLocation("zzz1-dc1")).toBeNull();
  });
});

describe("parseHetznerMetadata", () => {
  it("reads key: value lines", () => {
    expect(parseHetznerMetadata("hostname: web\navailability-zone: hel1-dc2\nregion: eu-central\n")).toMatchObject({
      "availability-zone": "hel1-dc2",
      region: "eu-central",
    });
  });
});

describe("judgeProviderCert", () => {
  const hetzner = (zone: string) => manualHosting({ provider: "hetzner", region: zone });
  it("is unknown with no provider", () => {
    expect(judgeProviderCert(null).state).toBe("unknown");
  });
  it("passes for a listed site", () => {
    expect(judgeProviderCert(hetzner("nbg1")).state).toBe("passing");
    expect(judgeProviderCert(hetzner("Falkenstein")).state).toBe("passing");
  });
  it("fails for Hillsboro, which the Hetzner certificate doesn't list", () => {
    const j = judgeProviderCert(hetzner("hil-dc1"));
    expect(j.state).toBe("failing");
    expect(j.evidence).toContain("Hillsboro");
  });
  it("is unknown for an unmatched region or an unrecognized provider", () => {
    expect(judgeProviderCert(hetzner("moon")).state).toBe("unknown");
    expect(judgeProviderCert(manualHosting({ provider: "Acme Cloud", region: "x" })).state).toBe("unknown");
  });
  it("is unknown for AWS, whose site list Vardo doesn't hold", () => {
    expect(judgeProviderCert({ provider: "AWS EC2", region: "us-east-1", location: null, source: "detected" }).state).toBe("unknown");
  });
});
