import type { MailContext } from "@/lib/email/notification-email";
import type { BusEvent } from "@/lib/bus/events";

/** Console origin, instance name and time zone for links, headers and times. */
export async function mailContext(organizationId: string | undefined): Promise<MailContext> {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  let instanceName = "Vardo";
  try {
    const { getInstanceDisplayName } = await import("@/lib/system-settings");
    instanceName = (await getInstanceDisplayName()) || new URL(baseUrl).hostname;
  } catch {
    // Defaults stand.
  }
  let timeZone: string | undefined;
  try {
    const { getOrgTimeZone } = await import("@/lib/time-zone-settings");
    timeZone = await getOrgTimeZone(organizationId);
  } catch {
    // Prints UTC.
  }
  return { baseUrl, instanceName, timeZone };
}

/** The delivery policy's verdict for this org. Settings that can't be read leave the default. */
export async function orgWantsEvent(
  event: BusEvent,
  organizationId: string | undefined,
): Promise<boolean> {
  const { emailsEvent, needsSettings } = await import("./delivery-policy");
  if (!needsSettings(event) || !organizationId) return emailsEvent(event, { categories: {} });
  try {
    const { readOrgNotificationSettings } = await import("./preferences");
    return emailsEvent(event, await readOrgNotificationSettings(organizationId));
  } catch {
    return emailsEvent(event, { categories: {} });
  }
}
