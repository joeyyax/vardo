import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { InboxContent } from "@/components/inbox/inbox-content";

export default async function InboxPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(orgData.organization.features as OrgFeatures | null),
  };

  if (!features.expenses) {
    redirect("/track");
  }

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Review forwarded emails and convert attachments to expenses.
        </p>
      </div>

      <InboxContent orgId={orgData.organization.id} />
    </div>
  );
}
