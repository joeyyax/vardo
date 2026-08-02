import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";

// The root not-found serves unmatched hostnames and keeps the ghost. Inside the
// console a 404 is a wrong link or a deleted app, so it says so and offers a way on.
export default function AuthenticatedNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <FileQuestion aria-hidden="true" className="size-8 text-muted-foreground" />
      <div className="space-y-1.5">
        <h1 className="type-h2">Not found</h1>
        <p className="text-sm text-muted-foreground">
          This page doesn&apos;t exist. The app or project may have been renamed or deleted,
          or the link may be out of date.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link href="/projects">Go to projects</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Press <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono">⌘K</kbd> to
        search for an app by name.
      </p>
    </div>
  );
}
