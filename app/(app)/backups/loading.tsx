export default function BackupsLoading() {
  return (
    <div className="space-y-6">
      {/* PageToolbar skeleton */}
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 w-24 bg-muted animate-pulse rounded-lg" />
        <div className="h-9 w-28 bg-muted animate-pulse rounded-lg" />
      </div>

      {/* Table skeleton */}
      <div className="rounded-xl border overflow-hidden">
        {/* Table header */}
        <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-3">
          {[100, 80, 120, 80, 60].map((w, i) => (
            <div key={i} className="h-3 bg-muted animate-pulse rounded-md" style={{ width: `${w}px` }} />
          ))}
        </div>

        {/* Table rows */}
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b last:border-0 bg-card px-4 py-3"
          >
            <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-20 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-28 bg-muted animate-pulse rounded-md" />
            <div className="h-5 w-16 bg-muted animate-pulse rounded-full" />
            <div className="ml-auto h-7 w-16 bg-muted animate-pulse rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
