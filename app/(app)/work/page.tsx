import { redirect } from "next/navigation";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { MyWorkContent } from "./my-work-content";

export default async function MyWorkPage() {
  const [orgData, session] = await Promise.all([getCurrentOrg(), getSession()]);
  if (!orgData || !session?.user?.id) redirect("/onboarding");

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">My Work</h1>
      </div>
      <MyWorkContent
        orgId={orgData.organization.id}
        currentUserId={session.user.id}
      />
    </div>
  );
}
