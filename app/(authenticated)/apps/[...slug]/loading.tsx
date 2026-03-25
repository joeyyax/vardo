export default function AppDetailLoading() {
  return (
    <div className="space-y-6">
      {/* App header: icon + name + status badge */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-muted animate-pulse rounded-xl shrink-0" />
          <div className="space-y-1.5">
            <div className="h-6 w-40 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-24 bg-muted animate-pulse rounded-lg" />
          <div className="h-9 w-9 bg-muted animate-pulse rounded-lg" />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border pb-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-9 bg-muted animate-pulse rounded-t-md"
            style={{ width: `${60 + i * 8}px` }}
          />
        ))}
      </div>

      {/* Content area: deployment list placeholder */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-lg border bg-card px-4 py-3">
            <div className="h-4 w-4 bg-muted animate-pulse rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-64 bg-muted animate-pulse rounded-md" />
              <div className="h-3 w-40 bg-muted animate-pulse rounded-md" />
            </div>
            <div className="h-5 w-16 bg-muted animate-pulse rounded-full shrink-0" />
            <div className="h-4 w-20 bg-muted animate-pulse rounded-md shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
