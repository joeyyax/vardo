export default function ProjectsLoading() {
  return (
    <div className="space-y-6">
      {/* PageToolbar skeleton */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="h-8 w-28 bg-muted animate-pulse rounded-lg" />
          <div className="h-6 w-24 bg-muted animate-pulse rounded-md" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-28 bg-muted animate-pulse rounded-lg" />
          <div className="h-5 w-16 bg-muted animate-pulse rounded-md" />
        </div>
      </div>

      {/* Project group skeletons */}
      <div className="space-y-8">
        {[1, 2].map((group) => (
          <div key={group} className="space-y-3">
            {/* Project group header */}
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 bg-muted animate-pulse rounded-full" />
              <div className="h-5 w-32 bg-muted animate-pulse rounded-md" />
            </div>

            {/* App cards grid */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: group === 1 ? 3 : 2 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border bg-card p-4 space-y-3"
                >
                  {/* App header: icon + name + status */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 bg-muted animate-pulse rounded-lg shrink-0" />
                      <div className="space-y-1">
                        <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
                        <div className="h-3 w-16 bg-muted animate-pulse rounded-md" />
                      </div>
                    </div>
                    <div className="h-5 w-5 bg-muted animate-pulse rounded-full shrink-0" />
                  </div>

                  {/* Sparkline placeholder */}
                  <div className="h-10 w-full bg-muted/50 animate-pulse rounded-md" />

                  {/* Footer: domain */}
                  <div className="h-3 w-36 bg-muted animate-pulse rounded-md" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
