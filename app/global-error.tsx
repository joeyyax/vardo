"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground antialiased">
        <div className="flex min-h-dvh items-center justify-center p-4">
          <div className="text-center space-y-4 max-w-sm">
            <p className="text-6xl font-mono font-light" style={{ color: "rgba(255,255,255,0.15)" }}>500</p>
            <div className="space-y-1">
              <p className="text-base font-medium" style={{ color: "rgba(255,255,255,0.7)" }}>
                Something went wrong
              </p>
              <p className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
                An unexpected error occurred. Try refreshing the page.
              </p>
            </div>
            {error.digest && (
              <p className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
                Error ID: {error.digest}
              </p>
            )}
            <button
              onClick={reset}
              style={{ color: "rgba(255,255,255,0.5)", textDecoration: "underline", fontSize: "14px" }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
