import { getInstanceBaseDomain } from "@/lib/domain-monitoring/base-domain";
import { getInstanceTimeZone } from "@/lib/time-zone-settings";
import { authorize, type Actor } from "./actor";

/** The org general settings tab. */
export async function loadOrgGeneralSettings(actor: Actor) {
  authorize(actor, "org.view");
  const { org } = actor;
  return {
    name: org.name,
    timeZone: org.timeZone ?? null,
    instanceTimeZone: await getInstanceTimeZone(),
    githubFeedback: org.githubFeedback ?? true,
    memoryProfile: org.memoryProfile,
    memoryAutoMaxMb: org.memoryAutoMaxMb ?? null,
  };
}

/** The org domain settings tab. */
export async function loadOrgDomainSettings(actor: Actor) {
  authorize(actor, "org.view");
  return {
    defaultDomain: await getInstanceBaseDomain(),
    sslEnabled: actor.org.sslEnabled ?? true,
    serverIP: process.env.VARDO_SERVER_IP,
  };
}
