import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;
  const canEdit = membership.role === "owner" || membership.role === "admin";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Configure your organization settings.
        </p>
      </div>

      <SettingsForm
        organization={organization}
        canEdit={canEdit}
      />
    </div>
  );
}
