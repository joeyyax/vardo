export function ProductPreview() {
  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-6 sm:pb-24 lg:px-8">
      <div className="overflow-hidden rounded-xl border border-border shadow-lg">
        {/* Browser chrome */}
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-3">
          <span className="size-3 rounded-full bg-border" />
          <span className="size-3 rounded-full bg-border" />
          <span className="size-3 rounded-full bg-border" />
          <div className="ml-3 flex-1">
            <div className="mx-auto max-w-xs rounded-md bg-background px-3 py-1 text-center text-xs text-muted-foreground">
              console.vardo.run
            </div>
          </div>
        </div>
        {/* Placeholder content */}
        <div className="flex min-h-[320px] items-center justify-center bg-gradient-to-br from-muted/30 via-background to-muted/50 sm:min-h-[400px]">
          <div className="text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-primary"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </div>
            <p className="text-sm font-medium text-foreground">
              Console screenshot coming soon
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Manage projects, deployments, and monitoring from one dashboard
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
