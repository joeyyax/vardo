import { describe, it, expect } from "vitest";
import { resolveContainerPort } from "@/lib/docker/resolve-port";

// resolveContainerPort priority chain:
//   Traefik label port → first exposed internal port → user-supplied → null

describe("resolveContainerPort", () => {
  it("returns the Traefik label port when present, ignoring other sources", () => {
    const detail = {
      containerPort: 8080,
      ports: [{ internal: 3000, protocol: "tcp" }],
    };
    expect(resolveContainerPort(detail, 9000)).toBe(8080);
  });

  it("falls back to the first exposed internal port when there is no Traefik label", () => {
    const detail = {
      containerPort: null,
      ports: [{ internal: 3000, protocol: "tcp" }, { internal: 4000, protocol: "tcp" }],
    };
    expect(resolveContainerPort(detail)).toBe(3000);
  });

  it("falls back to the user-supplied port when auto-detection yields nothing", () => {
    const detail = {
      containerPort: null,
      ports: [],
    };
    expect(resolveContainerPort(detail, 5000)).toBe(5000);
  });

  it("returns null when all sources are absent", () => {
    const detail = {
      containerPort: null,
      ports: [],
    };
    expect(resolveContainerPort(detail)).toBeNull();
  });
});
