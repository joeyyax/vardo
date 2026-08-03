import { describe, it, expect } from "vitest";

import {
  appSettingsFields,
  appSettingsPageFields,
  hasAppSettingsPageFields,
  APP_SETTINGS_PAGES,
  APP_SETTINGS_FIELD_PAGE,
  APP_SETTINGS_REDEPLOY_KEYS,
  type AppSettingsFieldContext,
  type AppSettingsFieldName,
  type AppSettingsFields,
} from "@/lib/ui/app-settings-fields";

function context(overrides: Partial<AppSettingsFieldContext> = {}): AppSettingsFieldContext {
  return {
    isComposeParent: false,
    isChildService: false,
    deployType: "compose",
    storedDeployType: "compose",
    source: "git",
    ...overrides,
  };
}

const plainApp = context();
const composeParent = context({ isComposeParent: true });
const childService = context({ isChildService: true });

describe("appSettingsFields", () => {
  it("gives a compose parent the settings that describe the whole stack", () => {
    const fields = appSettingsFields(composeParent);
    expect(fields.resourceLimits).toBe(true);
    expect(fields.priority).toBe(true);
    expect(fields.gpu).toBe(true);
    expect(fields.healthCheckTimeout).toBe(true);
    expect(fields.autoDeploy).toBe(true);
    expect(fields.autoRollback).toBe(true);
    expect(fields.project).toBe(true);
  });

  it("keeps the ingress settings a compose parent's domains read", () => {
    // containerPort and backendProtocol pick and reach the routed service.
    const fields = appSettingsFields(composeParent);
    expect(fields.containerPort).toBe(true);
    expect(fields.backendProtocol).toBe(true);
    expect(fields.gitSource).toBe(true);
  });

  it("withholds the per-container settings from a compose parent", () => {
    const fields = appSettingsFields(composeParent);
    // A stack has an image per service, and its alert threshold is matched by
    // container name — which every service's child row owns.
    expect(fields.image).toBe(false);
    expect(fields.diskWriteAlert).toBe(false);
  });

  it("withholds the image field from a compose parent adopted as an image app", () => {
    const fields = appSettingsFields(
      context({ isComposeParent: true, deployType: "image", storedDeployType: "image" }),
    );
    expect(fields.image).toBe(false);
    expect(fields.composeFilePath).toBe(false);
  });

  it("never lets a compose parent switch its deploy type away from compose", () => {
    const fields = appSettingsFields(composeParent);
    expect(fields.deployType).toBe(false);
    expect(fields.dockerfilePath).toBe(false);
    // The compose file the services are read from stays editable.
    expect(fields.composeFilePath).toBe(true);
  });

  it("only offers the inherit tier to a child service", () => {
    expect(appSettingsFields(childService).priorityInherit).toBe(true);
    expect(appSettingsFields(composeParent).priorityInherit).toBe(false);
    expect(appSettingsFields(plainApp).priorityInherit).toBe(false);
  });

  it("withholds what the parent stack controls from a child service", () => {
    const fields = appSettingsFields(childService);
    expect(fields.image).toBe(false);
    expect(fields.gitSource).toBe(false);
    expect(fields.deployType).toBe(false);
    expect(fields.composeFilePath).toBe(false);
    expect(fields.containerPort).toBe(false);
    expect(fields.backendProtocol).toBe(false);
    expect(fields.autoDeploy).toBe(false);
    expect(fields.autoRollback).toBe(false);
  });

  it("leaves a child service its own resources, tier and health", () => {
    const fields = appSettingsFields(childService);
    expect(fields.resourceLimits).toBe(true);
    expect(fields.priority).toBe(true);
    expect(fields.gpu).toBe(true);
    expect(fields.diskWriteAlert).toBe(true);
    expect(fields.healthCheckTimeout).toBe(true);
  });

  it("gives a plain app every field", () => {
    const fields = appSettingsFields(context({ deployType: "image", storedDeployType: "image" }));
    expect(fields.image).toBe(true);
    expect(fields.deployType).toBe(true);
    expect(fields.containerPort).toBe(true);
    expect(fields.diskWriteAlert).toBe(true);
  });

  it("follows the selected deploy type, not the stored one, for the path fields", () => {
    const switching = context({ deployType: "dockerfile", storedDeployType: "compose" });
    expect(appSettingsFields(switching).dockerfilePath).toBe(true);
    expect(appSettingsFields(switching).composeFilePath).toBe(false);
    // The image name still belongs to the app as stored.
    expect(appSettingsFields(switching).image).toBe(false);
  });

  it("hides the git source fields for an app that has no repo", () => {
    expect(appSettingsFields(context({ source: "image" })).gitSource).toBe(false);
    expect(appSettingsFields(context({ source: null })).gitSource).toBe(false);
  });

  it("shows a compose parent fewer fields than a plain app, never more", () => {
    const parent = appSettingsFields(context({ isComposeParent: true, storedDeployType: "image" }));
    const plain = appSettingsFields(context({ storedDeployType: "image" }));
    for (const key of Object.keys(parent) as (keyof AppSettingsFields)[]) {
      if (key === "priorityInherit") continue;
      if (parent[key]) expect(plain[key]).toBe(true);
    }
  });
});

const fieldNames = Object.keys(APP_SETTINGS_FIELD_PAGE) as AppSettingsFieldName[];

/** Field names the page shows for this app. */
function shown(page: (typeof APP_SETTINGS_PAGES)[number], ctx: AppSettingsFieldContext) {
  const fields = appSettingsPageFields(page, ctx);
  return fieldNames.filter((name) => fields[name]);
}

describe("APP_SETTINGS_FIELD_PAGE", () => {
  it("puts the ingress settings on the page that already owns domains", () => {
    expect(APP_SETTINGS_FIELD_PAGE.containerPort).toBe("networking");
    expect(APP_SETTINGS_FIELD_PAGE.backendProtocol).toBe("networking");
  });

  it("puts how the app runs on Resources", () => {
    expect(shown("resources", plainApp).sort()).toEqual([
      "diskWriteAlert",
      "gpu",
      "healthCheckTimeout",
      "priority",
      "resourceLimits",
      "restartPolicy",
    ]);
  });

  it("puts how the app is built and released on Build", () => {
    expect(shown("build", context({ storedDeployType: "image" })).sort()).toEqual([
      "autoDeploy",
      "autoRollback",
      "composeFilePath",
      "deployType",
      "gitSource",
      "image",
    ]);
  });

  it("leaves Settings the app's identity", () => {
    expect(shown("settings", plainApp).sort()).toEqual(["identity", "project"]);
  });

  it("gives every field exactly one page, and no field none", () => {
    // Two contexts, because the compose and Dockerfile path fields never show
    // together.
    const seen = new Map<AppSettingsFieldName, string>();
    for (const ctx of [
      context({ deployType: "compose", storedDeployType: "image" }),
      context({ deployType: "dockerfile", storedDeployType: "image" }),
    ]) {
      for (const page of APP_SETTINGS_PAGES) {
        for (const name of shown(page, ctx)) {
          expect(seen.get(name) ?? page).toBe(page);
          seen.set(name, page);
        }
      }
    }
    expect([...seen.keys()].sort()).toEqual([...fieldNames].sort());
  });

  it("keeps the redeploy seam on the keys Resources and Build write", () => {
    // Nothing on Settings earns the "Redeploy now" prompt; renaming an app and
    // halving its memory limit must not read as equally weighty.
    expect(APP_SETTINGS_REDEPLOY_KEYS).toContain("cpuLimit");
    expect(APP_SETTINGS_REDEPLOY_KEYS).toContain("memoryLimit");
    expect(APP_SETTINGS_REDEPLOY_KEYS).toContain("priority");
    expect(APP_SETTINGS_REDEPLOY_KEYS).toContain("gpuEnabled");
    expect(APP_SETTINGS_REDEPLOY_KEYS).not.toContain("displayName");
    expect(APP_SETTINGS_REDEPLOY_KEYS).not.toContain("projectId");
    expect(APP_SETTINGS_REDEPLOY_KEYS).not.toContain("healthCheckTimeout");
    expect(APP_SETTINGS_REDEPLOY_KEYS).not.toContain("diskWriteAlertThreshold");
  });
});

describe("appSettingsPageFields", () => {
  it("hides the other pages' fields, so a page writes only its own", () => {
    const resources = appSettingsPageFields("resources", plainApp);
    expect(resources.resourceLimits).toBe(true);
    expect(resources.identity).toBe(false);
    expect(resources.deployType).toBe(false);
    expect(resources.containerPort).toBe(false);
  });

  it("narrows the app's own fields, never widens them", () => {
    for (const ctx of [plainApp, composeParent, childService]) {
      const all = appSettingsFields(ctx);
      for (const page of APP_SETTINGS_PAGES) {
        const fields = appSettingsPageFields(page, ctx);
        for (const name of fieldNames) {
          if (fields[name]) expect(all[name]).toBe(true);
        }
      }
    }
  });

  it("keeps the inherit tier available wherever priority lands", () => {
    expect(appSettingsPageFields("resources", childService).priorityInherit).toBe(true);
  });
});

describe("hasAppSettingsPageFields", () => {
  it("leaves a child service no Build page — its stack owns the build", () => {
    expect(hasAppSettingsPageFields("build", childService)).toBe(false);
    expect(hasAppSettingsPageFields("networking", childService)).toBe(false);
  });

  it("keeps the pages a child service does own", () => {
    expect(hasAppSettingsPageFields("resources", childService)).toBe(true);
    expect(hasAppSettingsPageFields("settings", childService)).toBe(true);
  });

  it("gives a compose parent every page", () => {
    for (const page of APP_SETTINGS_PAGES) {
      expect(hasAppSettingsPageFields(page, composeParent)).toBe(true);
    }
  });

  it("gives a plain app every page, whatever it deploys from", () => {
    for (const ctx of [
      plainApp,
      context({ deployType: "image", storedDeployType: "image", source: "image" }),
      context({ deployType: "dockerfile", storedDeployType: "dockerfile" }),
    ]) {
      for (const page of APP_SETTINGS_PAGES) {
        expect(hasAppSettingsPageFields(page, ctx)).toBe(true);
      }
    }
  });
});
