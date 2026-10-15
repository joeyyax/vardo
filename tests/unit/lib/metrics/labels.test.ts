import { describe, it, expect } from "vitest";

import { identityLabels, organizationOf, projectOf } from "@/lib/metrics/labels";

describe("metrics labels", () => {
  it("keeps only the labels app matching reads", () => {
    expect(identityLabels({ "vardo.project.id": "a", "host.project": "b", "com.docker.compose.service": "web", "traefik.enable": "true" })).toEqual({
      "vardo.project.id": "a",
      "host.project": "b",
      "com.docker.compose.service": "web",
    });
  });

  it("names the project from Vardo's label, then the legacy one, then compose's", () => {
    expect(projectOf({ "vardo.project": "a", "host.project": "b", "com.docker.compose.project": "c" })).toBe("a");
    expect(projectOf({ "host.project": "b", "com.docker.compose.project": "c" })).toBe("b");
    expect(projectOf({ "com.docker.compose.project": "c" })).toBe("c");
    expect(projectOf({})).toBe("");
  });

  it("reads the organization, or null", () => {
    expect(organizationOf({ "host.organization": "org" })).toBe("org");
    expect(organizationOf(undefined)).toBeNull();
  });
});
