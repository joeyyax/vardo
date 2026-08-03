/** Tab segments the app route accepts at /apps/{slug}/{tab}. */
export const APP_TABS = [
  "apps",
  "deployments",
  "updates",
  "connect",
  "variables",
  "networking",
  "settings",
  "logs",
  "volumes",
  "cron",
  "terminal",
  "metrics",
  "backups",
  "security",
  "errors",
  "debug",
  "services",
  "compose",
] as const;

export type AppTab = (typeof APP_TABS)[number];

export function isAppTab(value: string): value is AppTab {
  return (APP_TABS as readonly string[]).includes(value);
}

/** What an app's shape and the instance's flags allow it to show. */
export type AppTabContext = {
  isComposeParent: boolean;
  isChildService: boolean;
  hasConnectionInfo: boolean;
  isOrgAdmin: boolean;
  features: FeatureToggles;
};

type FeatureToggles = {
  imageUpdates: boolean;
  terminal: boolean;
  cron: boolean;
  backups: boolean;
  errorTracking: boolean;
  metrics: boolean;
  logging: boolean;
};

/** Tabs the detail view renders for this app, in rail order. */
export function availableAppTabs(ctx: AppTabContext): AppTab[] {
  const f = ctx.features;
  if (ctx.isComposeParent) {
    return [
      "services",
      "deployments",
      ...(f.imageUpdates ? (["updates"] as const) : []),
      "variables",
      "networking",
      "compose",
      ...(f.cron ? (["cron"] as const) : []),
      "settings",
      ...(f.logging ? (["logs"] as const) : []),
      ...(f.metrics ? (["metrics"] as const) : []),
      ...(f.errorTracking ? (["errors"] as const) : []),
      "security",
      "volumes",
      ...(f.backups ? (["backups"] as const) : []),
      ...(f.terminal ? (["terminal"] as const) : []),
      ...(ctx.isOrgAdmin ? (["debug"] as const) : []),
    ];
  }
  return [
    "deployments",
    ...(f.imageUpdates ? (["updates"] as const) : []),
    ...(ctx.hasConnectionInfo ? (["connect"] as const) : []),
    "variables",
    "networking",
    ...(f.cron ? (["cron"] as const) : []),
    "settings",
    ...(f.logging ? (["logs"] as const) : []),
    ...(f.metrics ? (["metrics"] as const) : []),
    ...(f.errorTracking ? (["errors"] as const) : []),
    "security",
    "volumes",
    ...(f.backups ? (["backups"] as const) : []),
    ...(f.terminal ? (["terminal"] as const) : []),
    ...(ctx.isOrgAdmin ? (["debug"] as const) : []),
  ];
}

/** Tab shown when the URL names none, or names one this app can't show. */
export function defaultAppTab(ctx: AppTabContext): AppTab {
  if (ctx.isComposeParent) return "services";
  if (ctx.isChildService) return ctx.features.logging ? "logs" : "variables";
  return "deployments";
}

/** Resolve a requested tab against what this app can show, falling back to its default. */
export function resolveAppTab(requested: string | undefined, ctx: AppTabContext): AppTab {
  if (!requested) return defaultAppTab(ctx);
  const available = availableAppTabs(ctx);
  return available.includes(requested as AppTab)
    ? (requested as AppTab)
    : defaultAppTab(ctx);
}

/** The tab the shell's URL builder omits, so its path is the bare app path. */
export function rootAppTab(ctx: AppTabContext): AppTab {
  return ctx.isComposeParent ? "services" : "deployments";
}
