import { PageToolbar } from "@/components/page-toolbar";

export default function MetricsPage() {
  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
      </PageToolbar>

      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">
          CPU, memory, network, and disk usage across your projects.
        </p>
        <p className="text-xs text-muted-foreground">Coming soon.</p>
      </div>
    </div>
  );
}
