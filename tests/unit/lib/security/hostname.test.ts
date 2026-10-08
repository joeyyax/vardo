import { describe, it, expect } from "vitest";
import { isHostname } from "@/lib/security/hostname";

describe("isHostname", () => {
  it("accepts ordinary hostnames", () => {
    expect(isHostname("app.example.com")).toBe(true);
    expect(isHostname("preview-12.apps.localhost")).toBe(true);
  });

  it("refuses ports, paths and rule syntax", () => {
    expect(isHostname("169.254.169.254/latest?x=.localhost")).toBe(false);
    expect(isHostname("10.0.0.5:6379#.localhost")).toBe(false);
    expect(isHostname("a.test`) || Host(`b.test")).toBe(false);
    expect(isHostname("user@example.com")).toBe(false);
  });
});
