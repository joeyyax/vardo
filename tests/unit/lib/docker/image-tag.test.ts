import { describe, it, expect } from "vitest";
import { deploymentImageName } from "@/lib/docker/image-tag";

describe("deploymentImageName", () => {
  it("tags with the first eight characters of the deployment id", () => {
    expect(deploymentImageName("acme-org", "abcDEF12xyz")).toBe("host/acme-org:abcDEF12");
  });

  it("never starts a tag with a dash or dot", () => {
    expect(deploymentImageName("acme-org", "-IpDwINioEG")).toBe("host/acme-org:_IpDwINi");
    expect(deploymentImageName("acme-org", ".IpDwINioEG")).toBe("host/acme-org:_IpDwINi");
  });
});
