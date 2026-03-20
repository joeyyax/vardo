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
        <div className="flex min-h-dvh items-center justify-center">
          <div className="text-center space-y-3">
            <p className="text-6xl font-mono font-light" style={{ color: "rgba(255,255,255,0.15)" }}>500</p>
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>Something went wrong.</p>
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
