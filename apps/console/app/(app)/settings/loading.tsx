export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {/* Header: title + org switcher */}
      <div className="flex items-center gap-3">
        <div className="h-8 w-24 bg-muted animate-pulse rounded-lg" />
        <div className="h-6 w-28 bg-muted animate-pulse rounded-md" />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {[120, 88, 128, 72, 100].map((w, i) => (
          <div
            key={i}
            className="h-9 bg-muted animate-pulse rounded-t-md"
            style={{ width: `${w}px` }}
          />
        ))}
      </div>

      {/* Tab content: key-value rows */}
      <div className="space-y-3 pt-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
            <div className="space-y-1">
              <div className="h-4 w-32 bg-muted animate-pulse rounded-md" />
              <div className="h-3 w-48 bg-muted animate-pulse rounded-md" />
            </div>
            <div className="h-8 w-16 bg-muted animate-pulse rounded-lg shrink-0" />
          </div>
        ))}
        <div className="h-9 w-36 bg-muted animate-pulse rounded-lg" />
      </div>
    </div>
  );
}
