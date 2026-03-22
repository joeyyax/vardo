import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrgEnvVarsEditor } from "./org-env-vars";

export default async function SettingsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;

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
          <OrgEnvVarsEditor orgId={orgId} />
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
