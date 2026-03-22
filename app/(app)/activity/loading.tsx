export default function ActivityLoading() {
  return (
    <div className="space-y-6">
      {/* PageToolbar skeleton */}
      <div className="flex items-center gap-4">
        <div className="h-8 w-24 bg-muted animate-pulse rounded-lg" />
      </div>

      {/* Activity feed skeleton */}
      <div className="space-y-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg px-3 py-3">
            {/* Avatar */}
            <div className="h-8 w-8 bg-muted animate-pulse rounded-full shrink-0 mt-0.5" />

            {/* Content */}
            <div className="flex-1 space-y-1.5 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
                <div className="h-4 w-48 bg-muted animate-pulse rounded-md" />
              </div>
              <div className="h-3 w-28 bg-muted animate-pulse rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
