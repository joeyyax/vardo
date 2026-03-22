export default function ProfileLoading() {
  return (
    <div className="space-y-8">
      {/* Page title */}
      <div className="h-8 w-20 bg-muted animate-pulse rounded-lg" />

      {/* Account settings card */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="h-5 w-36 bg-muted animate-pulse rounded-md" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-3 w-16 bg-muted animate-pulse rounded-md" />
              <div className="h-10 w-full bg-muted animate-pulse rounded-lg" />
            </div>
          ))}
          <div className="h-9 w-24 bg-muted animate-pulse rounded-lg pt-2" />
        </div>
      </div>

      {/* Theme switcher card */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="h-5 w-24 bg-muted animate-pulse rounded-md" />
        <div className="flex items-center gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-9 w-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
