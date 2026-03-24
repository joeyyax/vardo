"use client";

import { useEffect } from "react";

export default function Error({
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
    <div className="flex min-h-dvh items-center justify-center bg-neutral-950">
      <div className="text-center space-y-3">
        <p className="text-6xl font-mono font-light text-neutral-800">500</p>
        <p className="text-sm text-neutral-500">Something went wrong.</p>
        <button
          onClick={reset}
          className="inline-block text-sm text-neutral-400 hover:text-white transition-colors underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
