export default function MetricsLoading() {
  return (
    <div className="space-y-6">
      {/* PageToolbar skeleton */}
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 w-24 bg-muted animate-pulse rounded-lg" />
      </div>

      {/* App selector + chart area */}
      <div className="space-y-4">
        {/* App selector row */}
        <div className="flex items-center gap-2 flex-wrap">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-8 w-20 bg-muted animate-pulse rounded-full" />
          ))}
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-4 space-y-2">
              <div className="h-3 w-16 bg-muted animate-pulse rounded-md" />
              <div className="h-7 w-24 bg-muted animate-pulse rounded-md" />
            </div>
          ))}
        </div>

        {/* Main chart area */}
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="h-5 w-20 bg-muted animate-pulse rounded-md" />
            <div className="flex gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-7 w-12 bg-muted animate-pulse rounded-md" />
              ))}
            </div>
          </div>
          <div className="h-56 w-full bg-muted/50 animate-pulse rounded-lg" />
        </div>
      </div>
    </div>
  );
}
