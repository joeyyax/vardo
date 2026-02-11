import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { TemplateListContent } from "./template-list-content";

export default async function TemplatesSettingsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;
  const canEdit = membership.role === "owner" || membership.role === "admin";

  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  // Only accessible if proposals feature is enabled
  if (!features.proposals) {
    redirect("/settings");
  }

  return (
    <TemplateListContent
      orgId={organization.id}
      canEdit={canEdit}
    />
  );
}
