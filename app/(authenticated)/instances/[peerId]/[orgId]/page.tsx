import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { RemoteOrgView } from "./remote-org-view";

export default async function RemoteOrgPage({ params }: { params: Promise<{ peerId: string; orgId: string }> }) {
  if (!(await getSession())) redirect("/login");
  const { peerId, orgId } = await params;
  return <RemoteOrgView peerId={peerId} orgId={orgId} />;
}
