import { describe, it, expect } from "vitest";

import { uniformStatus } from "@/lib/ui/status-colors";

describe("uniformStatus", () => {
  it("returns the shared status when every app agrees", () => {
    expect(uniformStatus(["missing", "missing", "missing"])).toBe("missing");
  });

  it("returns null when one app differs", () => {
    expect(uniformStatus(["missing", "missing", "error"])).toBeNull();
  });

  it("returns the status of a single-app project", () => {
    expect(uniformStatus(["stopped"])).toBe("stopped");
  });

  it("returns null for an empty project", () => {
    expect(uniformStatus([])).toBeNull();
  });
});
