import { describe, it, expect } from "vitest";

import { CORE_SERVICE_NAMES } from "@/lib/infra/core-services";
import { isInstanceInfraApp, probeAppName } from "@/lib/infra/instance-apps";

describe("isInstanceInfraApp", () => {
  it("claims Vardo's own stack and its compose children", () => {
    expect(isInstanceInfraApp("vardo")).toBe(true);
    expect(isInstanceInfraApp("vardo-frontend")).toBe(true);
    expect(isInstanceInfraApp("vardo-postgres")).toBe(true);
  });

  it("claims every core service", () => {
    for (const name of CORE_SERVICE_NAMES) expect(isInstanceInfraApp(name)).toBe(true);
  });

  it("leaves a tenant's apps alone", () => {
    expect(isInstanceInfraApp("plausible")).toBe(false);
    expect(isInstanceInfraApp("my-vardo-clone")).toBe(false);
    expect(isInstanceInfraApp(null)).toBe(false);
    expect(isInstanceInfraApp("")).toBe(false);
  });
});

describe("probeAppName", () => {
  it("maps every probe it knows onto an infrastructure app", () => {
    for (const service of ["PostgreSQL", "Redis", "Traefik", "WireGuard", "cAdvisor", "Loki", "Promtail", "GlitchTip"]) {
      const name = probeAppName(service);
      expect(name).not.toBeNull();
      expect(isInstanceInfraApp(name)).toBe(true);
    }
  });

  it("returns null for a probe with no app row", () => {
    expect(probeAppName("Docker")).toBeNull();
  });
});
