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
  /** Compose child service. */
  isChildService: boolean;
  /** A deploy is running or queued for this app. */
  deploying: boolean;
  /** A warm standby slot is up. */
  standbyAvailable: boolean;
  hasDeployed: boolean;
  /** An earlier successful deployment exists to roll back to. */
  rollbackTarget: boolean;
  /** Why stop is refused, when it is. */
  stopRefusal?: string | null;
};

const DEPLOY_IN_FLIGHT = "A deploy is running. Cancel it first.";
const NO_ROLLBACK_TARGET = "No successful deployment to roll back to.";

/**
 * Toolbar menu rows for this app, in order. Inapplicable start, restart, recreate
 * and instant rollback are hidden; rollback stays visible with its reason.
 */
export function appActionMenu(ctx: AppActionContext): AppActionItem[] {
  // Deploy and stop act on the parent's whole compose project.
  if (ctx.isChildService) return [{ action: "restart" }, { action: "logs" }];

  if (ctx.deploying || ctx.status === "deploying") {
    return [
      { action: "cancel-deploy" },
      { action: "deploy", disabled: DEPLOY_IN_FLIGHT },
      { action: "restart", disabled: DEPLOY_IN_FLIGHT },
      { action: "recreate", disabled: DEPLOY_IN_FLIGHT },
    ];
  }

  // Never deployed: no slot directory and no history.
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
    case "error":
      return [
        ...instantRollback,
        { action: "deploy" },
        { action: "restart" },
        { action: "recreate" },
        ...rollback,
        ...stop,
      ];
    // Stop stays on a down app: it marks the app down on purpose.
    // The slot directory is still on disk, so compose starts containers in place.
    case "stopped":
      return [
        { action: "start" },
        { action: "recreate" },
        { action: "deploy" },
        ...rollback,
        ...stop,
      ];
    case "missing":
      return [{ action: "recreate" }, { action: "deploy" }, ...rollback, ...stop];
    default:
      return [{ action: "deploy" }];
  }
}
