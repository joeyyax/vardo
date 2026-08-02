import { describe, it, expect } from "vitest";

import {
  APP_TABS,
  availableAppTabs,
  defaultAppTab,
  resolveAppTab,
  rootAppTab,
  type AppTabContext,
} from "@/lib/ui/app-tabs";

const allFeatures = {
  terminal: true,
  cron: true,
  backups: true,
  errorTracking: true,
  metrics: true,
  logging: true,
};

function context(overrides: Partial<AppTabContext> = {}): AppTabContext {
  return {
    isComposeParent: false,
    isChildService: false,
    hasConnectionInfo: false,
    isOrgAdmin: false,
    features: allFeatures,
    ...overrides,
  };
}

const composeParent = context({ isComposeParent: true });
const plainApp = context();
const childService = context({ isChildService: true });

describe("availableAppTabs", () => {
  it("gives a compose parent the stack sections", () => {
    expect(availableAppTabs(context({ isComposeParent: true, isOrgAdmin: true }))).toEqual([
      "services",
      "deployments",
      "updates",
      "variables",
      "networking",
      "compose",
      "logs",
      "metrics",
      "security",
      "volumes",
      "backups",
      "terminal",
      "debug",
    ]);
  });

  it("withholds per-container sections from a compose parent", () => {
    const tabs = availableAppTabs(composeParent);
    expect(tabs).not.toContain("cron");
    expect(tabs).not.toContain("errors");
    expect(tabs).not.toContain("connect");
  });

  it("drops parent tabs behind disabled feature flags", () => {
    const tabs = availableAppTabs(
      context({
        isComposeParent: true,
        isOrgAdmin: true,
        features: { ...allFeatures, terminal: false, backups: false },
      }),
    );
    expect(tabs).not.toContain("terminal");
    expect(tabs).not.toContain("backups");
    expect(tabs).toContain("networking");
    expect(tabs).toContain("volumes");
  });

  it("only offers a compose parent debug to org admins", () => {
    expect(availableAppTabs(composeParent)).not.toContain("debug");
    expect(
      availableAppTabs(context({ isComposeParent: true, isOrgAdmin: true })),
    ).toContain("debug");
  });

  it("gives a plain app the container sections, without stack-only ones", () => {
    const tabs = availableAppTabs(plainApp);
    expect(tabs).toContain("networking");
    expect(tabs).toContain("volumes");
    expect(tabs).toContain("security");
    expect(tabs).not.toContain("services");
    expect(tabs).not.toContain("compose");
  });

  it("only offers connect when the app publishes connection info", () => {
    expect(availableAppTabs(plainApp)).not.toContain("connect");
    expect(availableAppTabs(context({ hasConnectionInfo: true }))).toContain("connect");
  });

  it("only offers debug to org admins", () => {
    expect(availableAppTabs(plainApp)).not.toContain("debug");
    expect(availableAppTabs(context({ isOrgAdmin: true }))).toContain("debug");
  });

  it("drops tabs behind disabled feature flags", () => {
    const tabs = availableAppTabs(
      context({ features: { ...allFeatures, cron: false, metrics: false, backups: false } }),
    );
    expect(tabs).not.toContain("cron");
    expect(tabs).not.toContain("metrics");
    expect(tabs).not.toContain("backups");
    expect(tabs).toContain("logs");
  });

  it("never offers a tab the route doesn't accept", () => {
    for (const ctx of [composeParent, plainApp, childService]) {
      for (const tab of availableAppTabs(ctx)) {
        expect(APP_TABS).toContain(tab);
      }
    }
  });
});

describe("defaultAppTab", () => {
  it("lands a compose parent on services", () => {
    expect(defaultAppTab(composeParent)).toBe("services");
  });

  it("lands a plain app on deployments", () => {
    expect(defaultAppTab(plainApp)).toBe("deployments");
  });

  it("lands a child service on logs, or variables when logging is off", () => {
    expect(defaultAppTab(childService)).toBe("logs");
    expect(
      defaultAppTab(context({ isChildService: true, features: { ...allFeatures, logging: false } })),
    ).toBe("variables");
  });

  it("picks a default that is itself available", () => {
    for (const ctx of [composeParent, plainApp, childService]) {
      expect(availableAppTabs(ctx)).toContain(defaultAppTab(ctx));
    }
  });
});

describe("resolveAppTab", () => {
  it("keeps a tab the app can show", () => {
    expect(resolveAppTab("variables", plainApp)).toBe("variables");
    expect(resolveAppTab("compose", composeParent)).toBe("compose");
  });

  it("keeps a compose parent on the domain and exposure tabs", () => {
    // An unreachable-domain row links to /apps/{name}/networking.
    expect(resolveAppTab("networking", composeParent)).toBe("networking");
    expect(resolveAppTab("volumes", composeParent)).toBe("volumes");
    expect(resolveAppTab("security", composeParent)).toBe("security");
  });

  it("falls back when the tab isn't available for this app", () => {
    // The blank-column case: valid route segments the compose shell never renders.
    expect(resolveAppTab("cron", composeParent)).toBe("services");
    expect(resolveAppTab("errors", composeParent)).toBe("services");
    expect(resolveAppTab("compose", plainApp)).toBe("deployments");
    expect(resolveAppTab("services", plainApp)).toBe("deployments");
    expect(resolveAppTab("compose", childService)).toBe("logs");
  });

  it("falls back for a tab behind a disabled feature flag", () => {
    const noCron = context({ features: { ...allFeatures, cron: false } });
    expect(resolveAppTab("cron", noCron)).toBe("deployments");
  });

  it("falls back for a tab no shell renders", () => {
    expect(resolveAppTab("apps", plainApp)).toBe("deployments");
    expect(resolveAppTab("apps", composeParent)).toBe("services");
  });

  it("uses the default when no tab is requested", () => {
    expect(resolveAppTab(undefined, composeParent)).toBe("services");
    expect(resolveAppTab(undefined, childService)).toBe("logs");
  });

  it("always resolves every route tab to something the app renders", () => {
    for (const ctx of [composeParent, plainApp, childService]) {
      for (const tab of APP_TABS) {
        expect(availableAppTabs(ctx)).toContain(resolveAppTab(tab, ctx));
      }
    }
  });
});

describe("rootAppTab", () => {
  it("matches the tab each shell omits from the URL", () => {
    expect(rootAppTab(composeParent)).toBe("services");
    expect(rootAppTab(plainApp)).toBe("deployments");
    expect(rootAppTab(childService)).toBe("deployments");
  });
});
