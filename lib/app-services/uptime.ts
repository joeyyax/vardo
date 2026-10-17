import { uptimeClient } from "@/lib/uptime/client";
import { allows, authorize, type Actor } from "./actor";
import { NotFoundError } from "./errors";

/** The Uptime page: the org's monitors and the vantage points that check them. */
export async function loadUptimePage(actor: Actor) {
  authorize(actor, "uptime.view");
  const scope = { kind: "org", orgId: actor.org.id } as const;
  const [monitors, vantages] = await Promise.all([uptimeClient.listMonitors(scope), uptimeClient.listVantages()]);
  return { monitors, vantages, canManage: allows(actor, "uptime.manage") };
}

/** One monitor's page. */
export async function loadMonitorPage(actor: Actor, monitorId: string) {
  authorize(actor, "uptime.view");
  const [monitor, vantages] = await Promise.all([
    uptimeClient.getMonitor({ kind: "org", orgId: actor.org.id }, monitorId),
    uptimeClient.listVantages(),
  ]);
  if (!monitor) throw new NotFoundError("monitor");
  return { monitor, vantages, canManage: allows(actor, "uptime.manage") };
}
