import { PageToolbar } from "@/components/page-toolbar";

export default function BackupsPage() {
  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
      </PageToolbar>

      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">
          Scheduled backups, restore points, and retention policies.
        </p>
        <p className="text-xs text-muted-foreground">Coming soon.</p>
      </div>
    </div>
  );
}
