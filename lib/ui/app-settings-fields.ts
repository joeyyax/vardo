/** App shape that decides which settings fields show. */
export type AppSettingsFieldContext = {
  /** Has decomposed child apps. */
  isComposeParent: boolean;
  /** Has a parentAppId. */
  isChildService: boolean;
  /** Deploy type currently selected in the form, not the stored one. */
  deployType: string;
  /** Stored deploy type. */
  storedDeployType: string;
  source: string | null;
};

export type AppSettingsFields = {
  identity: boolean;
  image: boolean;
  gitSource: boolean;
  deployType: boolean;
  composeFilePath: boolean;
  dockerfilePath: boolean;
  /** Build and start command overrides for Railpack and Nixpacks. */
  buildOverrides: boolean;
  /** Railpack or Nixpacks when the repo has no compose file or Dockerfile. */
  buildProvider: boolean;
  containerPort: boolean;
  backendProtocol: boolean;
  securityHeaders: boolean;
  restartPolicy: boolean;
  resourceLimits: boolean;
  diskWriteAlert: boolean;
  /** Alerts on straying from the app's own baseline. */
  anomalyAlerts: boolean;
  priority: boolean;
  /** Offers the "inherit" tier, which only a child can resolve. */
  priorityInherit: boolean;
  /** Database, cache, worker, web or other. */
  kind: boolean;
  healthCheckTimeout: boolean;
  autoDeploy: boolean;
  autoRollback: boolean;
  gpu: boolean;
  project: boolean;
};

/** Fields the settings panel shows for this app. */
export function appSettingsFields(ctx: AppSettingsFieldContext): AppSettingsFields {
  const { isComposeParent, isChildService } = ctx;
  // Build, deploy and ingress belong to the stack.
  const ownsBuild = !isChildService;
  // Railpack or Nixpacks runs on an explicit type, or on compose when the repo has neither file.
  const buildpack = ownsBuild && !isComposeParent && ctx.source === "git"
    && ["compose", "nixpacks", "railpack"].includes(ctx.deployType);

  return {
    identity: true,
    image: ownsBuild && !isComposeParent && ctx.storedDeployType === "image",
    gitSource: ownsBuild && ctx.source === "git",
    // Switching a compose parent's type orphans its children.
    deployType: ownsBuild && !isComposeParent,
    composeFilePath: ownsBuild && ctx.deployType === "compose",
    dockerfilePath: ownsBuild && !isComposeParent && ctx.deployType === "dockerfile",
    buildOverrides: buildpack,
    buildProvider: buildpack && ctx.deployType === "compose",
    containerPort: ownsBuild,
    backendProtocol: ownsBuild,
    securityHeaders: ownsBuild,
    restartPolicy: true,
    resourceLimits: true,
    // Alerts match containers by name, which belong to child rows.
    diskWriteAlert: !isComposeParent,
    anomalyAlerts: true,
    priority: true,
    priorityInherit: isChildService,
    kind: !isComposeParent,
    healthCheckTimeout: true,
    autoDeploy: ownsBuild,
    autoRollback: ownsBuild,
    gpu: true,
    project: true,
  };
}

/** Sections the settings fields are split across, each its own rail entry. */
export const APP_SETTINGS_PAGES = ["networking", "build", "resources", "settings"] as const;

export type AppSettingsPage = (typeof APP_SETTINGS_PAGES)[number];

/** Every field except modifiers. */
export type AppSettingsFieldName = Exclude<keyof AppSettingsFields, "priorityInherit">;

/** The page each field is edited on. */
export const APP_SETTINGS_FIELD_PAGE: Record<AppSettingsFieldName, AppSettingsPage> = {
  identity: "settings",
  project: "settings",
  kind: "settings",
  containerPort: "networking",
  backendProtocol: "networking",
  securityHeaders: "networking",
  image: "build",
  gitSource: "build",
  deployType: "build",
  composeFilePath: "build",
  dockerfilePath: "build",
  buildOverrides: "build",
  buildProvider: "build",
  autoDeploy: "build",
  autoRollback: "build",
  restartPolicy: "resources",
  resourceLimits: "resources",
  priority: "resources",
  healthCheckTimeout: "resources",
  diskWriteAlert: "resources",
  anomalyAlerts: "resources",
  gpu: "resources",
};

/** PATCH body keys that need a redeploy to take effect. */
export const APP_SETTINGS_REDEPLOY_KEYS: readonly string[] = [
  "deployType",
  "buildCommand",
  "startCommand",
  "buildProvider",
  "gitBranch",
  "imageName",
  "rootDirectory",
  "containerPort",
  "backendProtocol",
  "securityHeaders",
  "restartPolicy",
  "cpuLimit",
  "memoryLimit",
  "memoryProfile",
  "memoryReservation",
  "priority",
  "gpuEnabled",
];

/** This app's fields narrowed to one page. */
export function appSettingsPageFields(
  page: AppSettingsPage,
  ctx: AppSettingsFieldContext,
): AppSettingsFields {
  const fields = appSettingsFields(ctx);
  const narrowed = { ...fields };
  for (const key of Object.keys(APP_SETTINGS_FIELD_PAGE) as AppSettingsFieldName[]) {
    narrowed[key] = fields[key] && APP_SETTINGS_FIELD_PAGE[key] === page;
  }
  return narrowed;
}

/** Whether the page has any fields to show. */
export function hasAppSettingsPageFields(
  page: AppSettingsPage,
  ctx: AppSettingsFieldContext,
): boolean {
  const fields = appSettingsPageFields(page, ctx);
  return (Object.keys(APP_SETTINGS_FIELD_PAGE) as AppSettingsFieldName[]).some((k) => fields[k]);
}
