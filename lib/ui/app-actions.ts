/** Operations the app toolbar can offer. */
export const APP_ACTIONS = [
  "cancel-deploy",
  "deploy",
  "start",
  "restart",
  "recreate",
  "instant-rollback",
  "rollback",
  "logs",
  "stop",
] as const;

export type AppAction = (typeof APP_ACTIONS)[number];

/** A menu row. `disabled` holds the reason shown under it. */
export type AppActionItem = { action: AppAction; disabled?: string };

export type AppActionContext = {
  status: "active" | "stopped" | "error" | "deploying" | "missing";
  /** Compose child service — the parent owns the compose project. */
  isChildService: boolean;
  /** A deploy is running or queued for this app. */
  deploying: boolean;
  /** A warm standby slot is up, so a rollback is a swap rather than a rebuild. */
  standbyAvailable: boolean;
  /** This app has deployment records. */
  hasDeployed: boolean;
  /** An earlier successful deployment exists to roll back to. */
  rollbackTarget: boolean;
  /** Why stop is refused, when it is. */
  stopRefusal?: string | null;
};

const DEPLOY_IN_FLIGHT = "A deploy is running. Cancel it first.";
const NO_ROLLBACK_TARGET = "No successful deployment to roll back to.";

/**
 * Rows the toolbar menu renders for this app, in order.
 *
 * Start, restart and recreate are dropped when they do not apply — the status
 * badge already says why, and disabling them adds dead rows to every menu.
 * Rollback stays visible and disabled instead: it is what people hunt for under
 * pressure, so the reason answers the question. Instant rollback goes the other
 * way and hides, because the standby disappears on the next deploy and a
 * disabled row would flicker in and out.
 */
export function appActionMenu(ctx: AppActionContext): AppActionItem[] {
  // Deploy and stop act on the parent's whole compose project: one would
  // redeploy the stack, the other would leave it half up.
  if (ctx.isChildService) return [{ action: "restart" }, { action: "logs" }];

  if (ctx.deploying || ctx.status === "deploying") {
    return [
      { action: "cancel-deploy" },
      { action: "deploy", disabled: DEPLOY_IN_FLIGHT },
      { action: "restart", disabled: DEPLOY_IN_FLIGHT },
      { action: "recreate", disabled: DEPLOY_IN_FLIGHT },
    ];
  }

  // Nothing has ever run from here, so there is no slot directory for the
  // container-level actions to act on and no history to teach.
  if (!ctx.hasDeployed && (ctx.status === "stopped" || ctx.status === "missing")) {
    return [{ action: "deploy" }];
  }

  const rollback: AppActionItem[] = !ctx.hasDeployed
    ? []
    : [{ action: "rollback", ...(ctx.rollbackTarget ? {} : { disabled: NO_ROLLBACK_TARGET }) }];

  const instantRollback: AppActionItem[] = ctx.standbyAvailable
    ? [{ action: "instant-rollback" }]
    : [];

  const stop: AppActionItem[] = [
    { action: "stop", ...(ctx.stopRefusal ? { disabled: ctx.stopRefusal } : {}) },
  ];

  switch (ctx.status) {
    case "active":
      return [
        { action: "deploy" },
        { action: "restart" },
        { action: "recreate" },
        ...instantRollback,
        ...rollback,
        ...stop,
      ];
    // A swap back to the standby beats rebuilding the version that crashed.
    case "error":
      return [
        ...instantRollback,
        { action: "deploy" },
        { action: "restart" },
        { action: "recreate" },
        ...rollback,
        ...stop,
      ];
    // The slot directory is still on disk, so compose can start the containers
    // in place instead of rebuilding them.
    case "stopped":
      return [{ action: "start" }, { action: "recreate" }, { action: "deploy" }, ...rollback];
    // No container to start, and nothing to restart.
    case "missing":
      return [{ action: "recreate" }, { action: "deploy" }, ...rollback];
    default:
      return [{ action: "deploy" }];
  }
}
