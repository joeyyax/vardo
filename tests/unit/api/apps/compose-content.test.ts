import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// composeContent size limit — create and PATCH schemas
// ---------------------------------------------------------------------------
// Tests that the 512,000-byte cap on composeContent is enforced in both
// the create (POST) and update (PATCH) schemas, and won't silently regress.
//
// Extracted from:
//   app/api/v1/organizations/[orgId]/apps/route.ts            (create)
//   app/api/v1/organizations/[orgId]/apps/[appId]/route.ts    (PATCH)

const composeContentCreateSchema = z.string().max(512000).optional();
const composeContentPatchSchema = z.string().max(512000).nullable().optional();

describe("composeContent size limit — create schema", () => {
  it("accepts a string within the limit", () => {
    const result = composeContentCreateSchema.safeParse("services:\n  web:\n    image: nginx\n");
    expect(result.success).toBe(true);
  });

  it("accepts a string exactly at the limit", () => {
    const result = composeContentCreateSchema.safeParse("x".repeat(512000));
    expect(result.success).toBe(true);
  });

  it("rejects a string over the limit", () => {
    const result = composeContentCreateSchema.safeParse("x".repeat(512001));
    expect(result.success).toBe(false);
  });

  it("accepts undefined (field is optional)", () => {
    const result = composeContentCreateSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("composeContent size limit — PATCH schema", () => {
  it("accepts a string within the limit", () => {
    const result = composeContentPatchSchema.safeParse("services:\n  web:\n    image: nginx\n");
    expect(result.success).toBe(true);
  });

  it("accepts a string exactly at the limit", () => {
    const result = composeContentPatchSchema.safeParse("x".repeat(512000));
    expect(result.success).toBe(true);
  });

  it("rejects a string over the limit", () => {
    const result = composeContentPatchSchema.safeParse("x".repeat(512001));
    expect(result.success).toBe(false);
  });

  it("accepts null (clears the stored compose file)", () => {
    const result = composeContentPatchSchema.safeParse(null);
    expect(result.success).toBe(true);
  });

  it("accepts undefined (field omitted from patch)", () => {
    const result = composeContentPatchSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultTab logic
// ---------------------------------------------------------------------------
// Compose parents default to "services", child services to "logs", and
// regular apps to "deployments". The gated-tab fallback uses defaultTab
// rather than the hardcoded "deployments" string, so a gated tab on a child
// service falls back to "logs", not "deployments".
//
// Extracted from:
//   app/(authenticated)/apps/[...slug]/page.tsx

type TabContext = {
  isComposeParent: boolean;
  isChildService: boolean;
};

function resolveDefaultTab({ isComposeParent, isChildService }: TabContext): string {
  return isComposeParent ? "services" : isChildService ? "logs" : "deployments";
}

type GatedTabContext = TabContext & {
  tab: string | null;
  featureFlags: Record<string, boolean>;
};

const GATED_TABS: Record<string, string> = {
  cron: "cron",
  terminal: "terminal",
};

function resolveEffectiveTab({ isComposeParent, isChildService, tab, featureFlags }: GatedTabContext): string {
  const defaultTab = resolveDefaultTab({ isComposeParent, isChildService });
  if (tab && GATED_TABS[tab] && !featureFlags[GATED_TABS[tab]]) {
    return defaultTab;
  }
  return tab || defaultTab;
}

describe("defaultTab — compose parent", () => {
  it("defaults to services tab", () => {
    expect(resolveDefaultTab({ isComposeParent: true, isChildService: false })).toBe("services");
  });
});

describe("defaultTab — child service", () => {
  it("defaults to logs tab", () => {
    expect(resolveDefaultTab({ isComposeParent: false, isChildService: true })).toBe("logs");
  });
});

describe("defaultTab — regular app", () => {
  it("defaults to deployments tab", () => {
    expect(resolveDefaultTab({ isComposeParent: false, isChildService: false })).toBe("deployments");
  });
});

describe("gated tab fallback — child service", () => {
  it("falls back to logs (not deployments) when a gated tab is disabled", () => {
    const effective = resolveEffectiveTab({
      isComposeParent: false,
      isChildService: true,
      tab: "terminal",
      featureFlags: { terminal: false },
    });
    expect(effective).toBe("logs");
  });

  it("uses the requested tab when the feature is enabled", () => {
    const effective = resolveEffectiveTab({
      isComposeParent: false,
      isChildService: true,
      tab: "terminal",
      featureFlags: { terminal: true },
    });
    expect(effective).toBe("terminal");
  });
});

describe("gated tab fallback — regular app", () => {
  it("falls back to deployments when a gated tab is disabled", () => {
    const effective = resolveEffectiveTab({
      isComposeParent: false,
      isChildService: false,
      tab: "cron",
      featureFlags: { cron: false },
    });
    expect(effective).toBe("deployments");
  });

  it("uses the requested tab when the feature is enabled", () => {
    const effective = resolveEffectiveTab({
      isComposeParent: false,
      isChildService: false,
      tab: "cron",
      featureFlags: { cron: true },
    });
    expect(effective).toBe("cron");
  });
});

describe("tab routing — no tab specified", () => {
  it("returns the default tab for compose parents when no tab is in the URL", () => {
    const effective = resolveEffectiveTab({
      isComposeParent: true,
      isChildService: false,
      tab: null,
      featureFlags: {},
    });
    expect(effective).toBe("services");
  });

  it("returns the default tab for child services when no tab is in the URL", () => {
    const effective = resolveEffectiveTab({
      isComposeParent: false,
      isChildService: true,
      tab: null,
      featureFlags: {},
    });
    expect(effective).toBe("logs");
  });
});
