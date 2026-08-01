/** Tab segments the app route accepts at /apps/{slug}/{tab}. */
export const APP_TABS = [
  "apps",
  "deployments",
  "updates",
  "connect",
  "variables",
  "networking",
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
