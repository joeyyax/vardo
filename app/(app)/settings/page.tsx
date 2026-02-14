import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { SettingsForm } from "./settings-form";
import { FeaturesForm } from "./features-form";
import { PaymentSettings } from "./payment-settings";
import { ImportWizard } from "@/components/settings/import-wizard";
import { DangerZone } from "@/components/settings/danger-zone";
import { getStripeStatus } from "@/lib/payments/stripe";
import { TaskTypesSettings } from "./task-types-settings";
import { TaskTagsSettings } from "./task-tags-settings";
import { SettingsTabs } from "./settings-tabs";
import { SecondMemberNudge } from "./second-member-nudge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

  // General tab
  const generalContent = (
    <>
      <SettingsForm
        organization={organization}
        canEdit={canEdit}
        features={features}
      />
      {features.secondMemberNudge && (
        <SecondMemberNudge organizationId={organization.id} />
      )}
      <FeaturesForm
        organizationId={organization.id}
        features={features}
        canEdit={canEdit}
      />
      {membership.role === "owner" && (
        <DangerZone orgId={organization.id} orgName={organization.name} />
      )}
    </>
  );

  // Workflow tab
  const workflowContent =
    features.pm || features.proposals ? (
      <>
        {features.pm && (
          <>
            <TaskTypesSettings orgId={organization.id} />
            <TaskTagsSettings orgId={organization.id} />
          </>
        )}
        {features.proposals && (
          <Card className="max-w-2xl squircle">
            <CardHeader>
              <CardTitle>Document Templates</CardTitle>
              <CardDescription>
                Manage templates for proposals, contracts, and change orders.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/settings/templates">
                <Button variant="outline" className="squircle">
                  Manage Templates
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </>
    ) : (
      <Card className="max-w-2xl squircle">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Enable Project Management or Proposals in the General tab to configure
          workflow settings.
        </CardContent>
      </Card>
    );

  // Billing tab
  const billingContent = features.invoicing ? (
    <PaymentSettings
      organizationId={organization.id}
      stripeStatus={getStripeStatus()}
      canEdit={canEdit}
    />
  ) : (
    <Card className="max-w-2xl squircle">
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        Enable Invoicing in the General tab to configure billing settings.
      </CardContent>
    </Card>
  );

  // Integrations tab
  const integrationsContent = features.time_tracking ? (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Import</h2>
        <p className="text-sm text-muted-foreground">
          Import time entries from other services.
        </p>
      </div>
      <ImportWizard orgId={organization.id} />
    </div>
  ) : (
    <Card className="max-w-2xl squircle">
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        No integrations are available for your current feature set.
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your organization settings.
        </p>
      </div>

      <Suspense fallback={null}>
        <SettingsTabs
          generalContent={generalContent}
          workflowContent={workflowContent}
          billingContent={billingContent}
          integrationsContent={integrationsContent}
        />
      </Suspense>
    </div>
  );
}
