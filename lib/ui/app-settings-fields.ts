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
