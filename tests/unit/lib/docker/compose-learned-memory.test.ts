import { describe, it, expect, beforeEach } from "vitest";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";
import type { ComposeFile, ServiceConfigOverride } from "@/lib/docker/compose-types";
import { resetHostCache, setResourceSettingsCache } from "@/lib/resources/host";

const compose = (memory?: string): ComposeFile => ({
  services: { web: { name: "web", image: "nginx", ...(memory ? { deploy: { resources: { limits: { memory } } } } : {}) } },
});

const memoryOf = (overlay: ComposeFile, svc = "web") => overlay.services[svc].deploy?.resources?.limits?.memory;

const overlay = (opts: Partial<Parameters<typeof buildVardoOverlay>[0]>) =>
  buildVardoOverlay({ fullCompose: compose(), networkName: "vardo-network", hostCpus: 4, ...opts });

beforeEach(() => {
  resetHostCache(null);
  setResourceSettingsCache({});
});

describe("learned memory default in the overlay", () => {
  it("replaces the tier default", () => {
    expect(memoryOf(overlay({}))).toBe("1024M");
    expect(memoryOf(overlay({ learnedMemoryMb: 576 }))).toBe("576M");
  });

  it("loses to the app's limit, including none", () => {
    expect(memoryOf(overlay({ memoryLimit: 2048, learnedMemoryMb: 576 }))).toBe("2048M");
    expect(memoryOf(overlay({ memoryLimit: 0, learnedMemoryMb: 576 }))).toBeUndefined();
  });

  it("loses to a limit the compose declares", () => {
    expect(memoryOf(overlay({ fullCompose: compose("3g"), learnedMemoryMb: 576 }))).toBe("3g");
  });

  it("comes per service from a stack child's config", () => {
    const cfg = (o: Partial<ServiceConfigOverride>): ServiceConfigOverride => ({ cpuLimit: null, memoryLimit: null, gpuEnabled: false, priority: null, ...o });
    expect(memoryOf(overlay({ learnedMemoryMb: 576, serviceConfig: { web: cfg({ learnedMemoryMb: 320 }) } }))).toBe("320M");
    expect(memoryOf(overlay({ learnedMemoryMb: 576, serviceConfig: { web: cfg({}) } }))).toBe("1024M");
    expect(memoryOf(overlay({ serviceConfig: { web: cfg({ memoryLimit: 900, learnedMemoryMb: 320 }) } }))).toBe("900M");
  });
});
