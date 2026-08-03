import { describe, it, expect } from "vitest";

import {
  appSettingsFields,
  type AppSettingsFieldContext,
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
