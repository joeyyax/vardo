import type { MailFooter } from "./components";

/** What every notification template needs besides its event. */
export type MailContext = {
  /** Console origin, no trailing slash. */
  baseUrl: string;
  instanceName: string;
  orgName?: string;
  /** History the charts draw from; missing series leave their chart out. */
  series?: MailSeries;
};

export type MailSeries = {
  /** Docker disk usage in bytes, one point per hour, oldest first. */
  dockerDisk24h?: number[];
  /** Bytes the alerting container wrote per hour, oldest first. */
  diskWritesHourly?: number[];
};

export function footerFor(ctx: MailContext): MailFooter {
  return {
    instanceName: ctx.instanceName,
    orgName: ctx.orgName,
    settingsUrl: `${ctx.baseUrl}/user/settings/notifications`,
  };
}

/** /apps/{id}, or a tab of it. Tabs are path segments, never `?tab=`. */
export function appPage(ctx: MailContext, appId: string, tab?: string): string {
  return `${ctx.baseUrl}/apps/${appId}${tab ? `/${tab}` : ""}`;
}

export function consolePage(ctx: MailContext, path = ""): string {
  return `${ctx.baseUrl}${path}`;
}
