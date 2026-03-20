import { PageToolbar } from "@/components/page-toolbar";

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      </PageToolbar>

      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">
          Deployments, configuration changes, and audit trail.
        </p>
        <p className="text-xs text-muted-foreground">Coming soon.</p>
      </div>
    </div>
  );
}
