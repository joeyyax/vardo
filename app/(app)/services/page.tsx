import { PageToolbar } from "@/components/page-toolbar";

export default function ServicesPage() {
  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-xl font-semibold tracking-tight">Services</h1>
      </PageToolbar>

      <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">
          No services deployed yet. Create your first service to get started.
        </p>
      </div>
    </div>
  );
}
