import { describe, it, expect } from "vitest";

import { CORE_SERVICE_NAMES } from "@/lib/infra/core-services";
import { appScope, isInstanceInfraApp, probeAppName } from "@/lib/infra/instance-apps";

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

// The value stamped as vardo.scope. Promtail routes anything "instance" to the
// tenant no organization can read, so a service missing from here leaks its
// logs — and its error output quotes other organizations — into an org tenant.
describe("appScope", () => {
  it("marks every core service and every part of Vardo's own stack", () => {
    for (const name of [...CORE_SERVICE_NAMES, "vardo", "vardo-postgres", "vardo-frontend"]) {
      expect(appScope(name)).toBe("instance");
    }
  });

  it("covers every service a health probe watches", () => {
    for (const service of ["PostgreSQL", "Redis", "Traefik", "WireGuard", "cAdvisor", "Loki", "Promtail"]) {
      expect(appScope(probeAppName(service))).toBe("instance");
    }
  });

  it("leaves a tenant's app as its own", () => {
    expect(appScope("plausible")).toBe("app");
    expect(appScope("my-vardo-clone")).toBe("app");
  });

  it("does not claim an unnamed app, which would hide a tenant's logs", () => {
    expect(appScope(null)).toBe("app");
    expect(appScope("")).toBe("app");
  });
});

describe("probeAppName", () => {
  it("maps every probe it knows onto an infrastructure app", () => {
    for (const service of ["PostgreSQL", "Redis", "Traefik", "WireGuard", "cAdvisor", "Loki", "Promtail"]) {
      const name = probeAppName(service);
      expect(name).not.toBeNull();
      expect(isInstanceInfraApp(name)).toBe(true);
    }
  });

  it("returns null for a probe with no app row", () => {
    expect(probeAppName("Docker")).toBeNull();
  });
});
