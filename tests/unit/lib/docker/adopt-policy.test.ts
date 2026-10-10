import { describe, it, expect } from "vitest";

import { adoptAllowsBindMounts } from "@/lib/docker/adopt-policy";

const base = {
  orgTrusted: false,
  projectAllowBindMounts: false,
  featureEnabled: false,
};

describe("adoptAllowsBindMounts", () => {
  it("allows a production adopt when the project allows bind mounts", () => {
    // The regression: this returned false, so adopting tautulli into `media`
    // silently dropped its config mount and would have started it empty.
    expect(adoptAllowsBindMounts({ ...base, projectAllowBindMounts: true })).toBe(true);
  });

  it("refuses when the project does not allow them", () => {
    expect(adoptAllowsBindMounts(base)).toBe(false);
  });

  it("allows a trusted org", () => {
    expect(adoptAllowsBindMounts({ ...base, orgTrusted: true })).toBe(true);
  });

  it("treats a project that does not exist yet as not allowing them", () => {
    expect(adoptAllowsBindMounts({ ...base, projectAllowBindMounts: null })).toBe(false);
    expect(adoptAllowsBindMounts({ ...base, projectAllowBindMounts: undefined })).toBe(false);
  });

  it("honors the instance feature flag", () => {
    expect(adoptAllowsBindMounts({ ...base, featureEnabled: true })).toBe(true);
  });
});
