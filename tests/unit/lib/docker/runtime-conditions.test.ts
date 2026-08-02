import { describe, it, expect } from "vitest";

import {
  hasRuntimeConditions,
  withoutRuntimeConditions,
} from "@/lib/docker/runtime-conditions";
import type { AppCondition } from "@/lib/docker/conditions";

const cond = (kind: AppCondition["kind"]): AppCondition => ({
  kind,
  severity: "warning",
  since: "2026-08-01T00:00:00.000Z",
  detail: kind,
});

describe("withoutRuntimeConditions", () => {
  // The production case: authentik reporting a crash loop with 0/4 services up.
  it("drops conditions that describe a running container", () => {
    const kept = withoutRuntimeConditions([
      cond("crash-looping"),
      cond("unhealthy"),
      cond("memory-pressure"),
      cond("self-heal-exhausted"),
    ]);
    expect(kept).toEqual([]);
  });

  // A missing backup is no less missing while the app is stopped.
  it("keeps advisory conditions", () => {
    const kept = withoutRuntimeConditions([
      cond("crash-looping"),
      cond("backup-missing"),
      cond("cert-expiring"),
      cond("security-findings"),
    ]);
    expect(kept.map((c) => c.kind)).toEqual([
      "backup-missing",
      "cert-expiring",
      "security-findings",
    ]);
  });

  it("handles an app with no conditions", () => {
    expect(withoutRuntimeConditions(null)).toEqual([]);
    expect(withoutRuntimeConditions([])).toEqual([]);
  });
});

describe("hasRuntimeConditions", () => {
  it("is true only when something would be stripped", () => {
    expect(hasRuntimeConditions([cond("crash-looping")])).toBe(true);
    expect(hasRuntimeConditions([cond("backup-stale")])).toBe(false);
    expect(hasRuntimeConditions(null)).toBe(false);
  });
});
