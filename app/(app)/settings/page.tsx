import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { orgEnvVars } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrgEnvVarsEditor } from "./org-env-vars";

export default async function SettingsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;

  const vars = await db.query.orgEnvVars.findMany({
    where: eq(orgEnvVars.organizationId, orgId),
  });

  // Mask secrets for initial display
  const safeVars = vars.map((v) => ({
    ...v,
    value: v.isSecret ? "" : v.value,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your organization settings.
        </p>
      </div>

      <Tabs defaultValue="variables">
        <TabsList variant="line">
          <TabsTrigger value="variables">Shared Variables</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>

        <TabsContent value="variables" className="pt-4">
          <OrgEnvVarsEditor
            orgId={orgId}
            initialVars={safeVars}
          />
        </TabsContent>

        <TabsContent value="domains" className="pt-4">
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">
                Base domain for auto-generated project URLs.
              </p>
              <p className="text-sm font-mono mt-2">
                {orgData.organization.baseDomain || "joeyyax.dev"}{" "}
                <span className="text-muted-foreground text-xs font-sans">
                  {orgData.organization.baseDomain ? "(custom)" : "(default)"}
                </span>
              </p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="general" className="pt-4">
          <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
            <p className="text-sm text-muted-foreground">
              General settings coming soon.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
