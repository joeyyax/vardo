import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { SettingsForm } from "./settings-form";
import { ImportWizard } from "@/components/settings/import-wizard";
import { DangerZone } from "@/components/settings/danger-zone";

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

      {/* Import */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Import</h2>
          <p className="text-sm text-muted-foreground">
            Import time entries from other services.
          </p>
        </div>
        <ImportWizard orgId={organization.id} />
      </div>

      {/* Danger Zone - only show to owners */}
      {membership.role === "owner" && (
        <div className="space-y-4">
          <DangerZone orgId={organization.id} orgName={organization.name} />
        </div>
      )}
    </div>
  );
}
