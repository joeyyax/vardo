import { uptimeClient } from "@/lib/uptime/client";
import { getOrgTimeZone } from "@/lib/time-zone-settings";
import { allows, authorize, type Actor } from "./actor";
import { NotFoundError } from "./errors";

/** The Uptime page: the org's monitors and the vantage points that check them. */
export async function loadUptimePage(actor: Actor) {
  authorize(actor, "org.view");
  const scope = { kind: "org", orgId: actor.org.id } as const;
  const [monitors, vantages, timeZone] = await Promise.all([uptimeClient.listMonitors(scope), uptimeClient.listVantages(), getOrgTimeZone(actor.org.id)]);
  return { monitors, vantages, timeZone, canManage: allows(actor, "uptime.manage") };
}

/** One monitor's page. */
export async function loadMonitorPage(actor: Actor, monitorId: string) {
  authorize(actor, "org.view");
  const [monitor, vantages, timeZone] = await Promise.all([
    uptimeClient.getMonitor({ kind: "org", orgId: actor.org.id }, monitorId),
    uptimeClient.listVantages(),
    getOrgTimeZone(actor.org.id),
  ]);
  if (!monitor) throw new NotFoundError("monitor");
  return { monitor, vantages, timeZone, canManage: allows(actor, "uptime.manage") };
}
