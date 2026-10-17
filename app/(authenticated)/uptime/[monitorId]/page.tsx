import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadMonitorPage } from "@/lib/app-services/uptime";
import { MonitorDetail } from "@/components/uptime/monitor-detail";

type PageProps = { params: Promise<{ monitorId: string }> };

export default async function MonitorPage({ params }: PageProps) {
  const { monitorId } = await params;
  const actor = await currentActor();
  if (!actor) redirect("/onboarding");

  const data = await pageData(loadMonitorPage(actor, monitorId));
  return <MonitorDetail orgId={actor.org.id} initial={data.monitor} vantages={data.vantages} canManage={data.canManage} timeZone={data.timeZone} />;
}
