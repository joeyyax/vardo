import { redirect } from "next/navigation";
import { isAppAdmin } from "@/lib/auth/admin";
import { getFlagConfig, isFeatureEnabledAsync } from "@/lib/config/features";
import { loadMetricsPageScope } from "@/lib/metrics/page-scope";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { OrgMetrics } from "./org-metrics";
import { ScopePicker, ScopeSwitch } from "./scope-picker";

type PageProps = {
  searchParams: Promise<{ scope?: string | string[] }>;
};

export default async function MetricsPage({ searchParams }: PageProps) {
  const { scope: rawScope } = await searchParams;
  const scope = await loadMetricsPageScope(Array.isArray(rawScope) ? rawScope[0] : rawScope);

  if (scope.kind === "none") redirect("/login");

  const metricsEnabled = await isFeatureEnabledAsync("metrics");
  const flag = getFlagConfig("metrics");

  if (scope.kind === "switch") {
    return (
      <div className="space-y-6">
        <PageToolbar>
          <h1 className="type-h1">Metrics</h1>
        </PageToolbar>
        <ScopeSwitch orgId={scope.orgId} />
      </div>
    );
  }

  const pickerValue = scope.kind === "server" ? "server" : scope.orgId;

  return (
    <div className="space-y-6">
      <PageToolbar>
        <div className="flex items-center gap-3">
          <h1 className="type-h1">Metrics</h1>
          {metricsEnabled && (scope.canServer || scope.orgs.length > 1) && (
            <ScopePicker
              value={pickerValue}
              canServer={scope.canServer}
              orgs={scope.orgs}
              currentOrgId={scope.orgId}
            />
          )}
        </div>
      </PageToolbar>

      {metricsEnabled ? (
        <OrgMetrics
          key={pickerValue}
          scope={scope.kind}
          orgId={scope.orgId}
          orgName={scope.orgName}
          apps={scope.apps}
        />
      ) : (
        <FeatureDisabled
          name={flag.label}
          description={flag.description}
          canManage={await isAppAdmin()}
        />
      )}
    </div>
  );
}
