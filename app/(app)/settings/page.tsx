import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { SettingsForm } from "./settings-form";
import { FeaturesForm } from "./features-form";
import { PersonalPreferences } from "./personal-preferences";
import { PaymentSettings } from "./payment-settings";
import { ImportWizard } from "@/components/settings/import-wizard";
import { DangerZone } from "@/components/settings/danger-zone";
import { NotificationPreferences } from "./notification-preferences";
import { getStripeStatus } from "@/lib/payments/stripe";

export default async function SettingsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;
  const canEdit = membership.role === "owner" || membership.role === "admin";

  // Merge org features with defaults (handle legacy orgs without features)
  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  return (
    <div className="space-y-8">
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </div>

      {/* Personal Preferences - only show if time tracking is enabled */}
      {features.time_tracking && <PersonalPreferences />}

      {/* Organization Settings */}
      <SettingsForm
        organization={organization}
        canEdit={canEdit}
        features={features}
      />

      {/* Features */}
      <FeaturesForm
        organizationId={organization.id}
        features={features}
        canEdit={canEdit}
      />

      {/* Document Templates - only show if proposals feature is enabled */}
      {features.proposals && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium">Document Templates</h2>
              <p className="text-sm text-muted-foreground">
                Manage templates for proposals, contracts, and change orders.
              </p>
            </div>
            <Link
              href="/settings/templates"
              className="text-sm text-primary hover:underline"
            >
              Manage Templates
            </Link>
          </div>
        </div>
      )}

      {/* Notification Preferences */}
      <NotificationPreferences />

      {/* Payment Providers - only show if invoicing is enabled */}
      {features.invoicing && (
        <PaymentSettings
          organizationId={organization.id}
          stripeStatus={getStripeStatus()}
          canEdit={canEdit}
        />
      )}

      {/* Import - only show if time tracking is enabled */}
      {features.time_tracking && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-medium">Import</h2>
            <p className="text-sm text-muted-foreground">
              Import time entries from other services.
            </p>
          </div>
          <ImportWizard orgId={organization.id} />
        </div>
      )}

      {/* Danger Zone - only show to owners */}
      {membership.role === "owner" && (
        <div className="space-y-4">
          <DangerZone orgId={organization.id} orgName={organization.name} />
        </div>
      )}
    </div>
  );
}
