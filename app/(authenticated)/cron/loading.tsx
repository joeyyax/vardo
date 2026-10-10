import { Card } from "@/components/ui/card";

export default function CronLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 w-24 bg-muted animate-pulse rounded-lg" />
      </div>

      <Card variant="surface" className="overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b last:border-0 bg-card px-4 py-3">
            <div className="h-4 w-32 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-48 bg-muted animate-pulse rounded-md" />
            <div className="ml-auto h-7 w-20 bg-muted animate-pulse rounded-md" />
          </div>
        ))}
      </Card>
    </div>
  );
}
