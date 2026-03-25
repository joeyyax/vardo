export default function AdminLoading() {
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 w-28 bg-muted animate-pulse rounded-lg" />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {[88, 72, 120, 72, 120, 88].map((w, i) => (
          <div
            key={i}
            className="h-9 bg-muted animate-pulse rounded-t-md"
            style={{ width: `${w}px` }}
          />
        ))}
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 pt-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-2">
            <div className="h-3 w-20 bg-muted animate-pulse rounded-md" />
            <div className="h-8 w-16 bg-muted animate-pulse rounded-md" />
          </div>
        ))}
      </div>

      {/* Table area */}
      <div className="rounded-xl border overflow-hidden">
        <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-3">
          {[120, 160, 100, 80].map((w, i) => (
            <div key={i} className="h-3 bg-muted animate-pulse rounded-md" style={{ width: `${w}px` }} />
          ))}
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b last:border-0 bg-card px-4 py-3">
            <div className="h-4 w-28 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-40 bg-muted animate-pulse rounded-md" />
            <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
            <div className="h-5 w-16 bg-muted animate-pulse rounded-full ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
