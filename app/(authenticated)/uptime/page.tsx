import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadUptimePage } from "@/lib/app-services/uptime";
import { UptimeMonitors } from "@/components/uptime/uptime-monitors";

export default async function UptimePage() {
  const actor = await currentActor();
  if (!actor) redirect("/onboarding");

  const data = await pageData(loadUptimePage(actor));
  return <UptimeMonitors orgId={actor.org.id} initialMonitors={data.monitors} vantages={data.vantages} canManage={data.canManage} timeZone={data.timeZone} />;
}
