import { redirect, notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { TemplateEditorContent } from "./template-editor-content";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function TemplateEditorPage({ params }: Props) {
  const { id } = await params;

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

  if (!features.proposals) {
    redirect("/settings");
  }

  return (
    <TemplateEditorContent
      orgId={organization.id}
      templateId={id}
      canEdit={canEdit}
    />
  );
}
