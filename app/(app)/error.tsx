"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] items-center justify-center p-4">
      <div className="text-center space-y-4 max-w-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-status-error-muted">
          <AlertTriangle className="size-5 text-status-error" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">
            {error.message && error.message !== "An error occurred in the Server Components render."
              ? error.message
              : "An unexpected error occurred. Please try again or contact support if the problem persists."}
          </p>
        </div>
        {error.digest && (
          <p className="text-xs text-muted-foreground font-mono">
            Error ID: {error.digest}
          </p>
        )}
        <Button onClick={reset} variant="outline" size="sm">
          <RotateCcw className="mr-1.5 size-3.5" />
          Try again
        </Button>
      </div>
    </div>
  );
}
