/** What an app's shape decides about the settings panel's fields. */
export type AppSettingsFieldContext = {
  /** Has decomposed child apps — the row is a stack, not a container. */
  isComposeParent: boolean;
  /** Has a parentAppId — one service inside a stack. */
  isChildService: boolean;
  /** Deploy type currently selected in the form, not the stored one. */
  deployType: string;
  /** Stored deploy type, which decides whether there is an image to name. */
  storedDeployType: string;
  source: string | null;
};

export type AppSettingsFields = {
  /** Display name and description. */
  identity: boolean;
  image: boolean;
  gitSource: boolean;
  deployType: boolean;
  composeFilePath: boolean;
  dockerfilePath: boolean;
  containerPort: boolean;
  backendProtocol: boolean;
  restartPolicy: boolean;
  resourceLimits: boolean;
  diskWriteAlert: boolean;
  priority: boolean;
  /** Offers the "inherit" tier, which only a child can resolve. */
  priorityInherit: boolean;
  healthCheckTimeout: boolean;
  autoDeploy: boolean;
  autoRollback: boolean;
  gpu: boolean;
  project: boolean;
};

/**
 * Fields the settings panel shows for this app. A child service hides what its
 * parent stack controls; a compose parent hides what only a single container has.
 */
export function appSettingsFields(ctx: AppSettingsFieldContext): AppSettingsFields {
  const { isComposeParent, isChildService } = ctx;
  // Build, deploy and ingress belong to the stack, so a child service shows none.
  const ownsBuild = !isChildService;

  return {
    identity: true,
    // A stack has an image per service, named in its compose file.
    image: ownsBuild && !isComposeParent && ctx.storedDeployType === "image",
    gitSource: ownsBuild && ctx.source === "git",
    // A row with children is compose by definition; switching it orphans them.
    deployType: ownsBuild && !isComposeParent,
    composeFilePath: ownsBuild && ctx.deployType === "compose",
    dockerfilePath: ownsBuild && !isComposeParent && ctx.deployType === "dockerfile",
    containerPort: ownsBuild,
    backendProtocol: ownsBuild,
    restartPolicy: true,
    resourceLimits: true,
    // Alerts match a container by name, and every service's name belongs to a
    // child row — a stack-level threshold would never be read.
    diskWriteAlert: !isComposeParent,
    priority: true,
    priorityInherit: isChildService,
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

/** Every field, minus the modifiers that only change how one is offered. */
export type AppSettingsFieldName = Exclude<keyof AppSettingsFields, "priorityInherit">;

/** The page each field is edited on. One field, one page. */
export const APP_SETTINGS_FIELD_PAGE: Record<AppSettingsFieldName, AppSettingsPage> = {
  identity: "settings",
  project: "settings",
  containerPort: "networking",
  backendProtocol: "networking",
  image: "build",
  gitSource: "build",
  deployType: "build",
  composeFilePath: "build",
  dockerfilePath: "build",
  autoDeploy: "build",
  autoRollback: "build",
  restartPolicy: "resources",
  resourceLimits: "resources",
  priority: "resources",
  healthCheckTimeout: "resources",
  diskWriteAlert: "resources",
  gpu: "resources",
};

/**
 * PATCH body keys the container only picks up when it is recreated. Saving one
 * of these earns the "Redeploy now" prompt; everything else applies on save.
 */
export const APP_SETTINGS_REDEPLOY_KEYS: readonly string[] = [
  "deployType",
  "gitBranch",
  "imageName",
  "rootDirectory",
  "containerPort",
  "backendProtocol",
  "restartPolicy",
  "cpuLimit",
  "memoryLimit",
  "priority",
  "gpuEnabled",
];

/** This app's fields narrowed to one page — the rest read as hidden, so unwritten. */
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

/** Whether the page has anything to show — an empty one gets no rail entry. */
export function hasAppSettingsPageFields(
  page: AppSettingsPage,
  ctx: AppSettingsFieldContext,
): boolean {
  const fields = appSettingsPageFields(page, ctx);
  return (Object.keys(APP_SETTINGS_FIELD_PAGE) as AppSettingsFieldName[]).some((k) => fields[k]);
}
