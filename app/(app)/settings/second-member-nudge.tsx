"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Info, X } from "lucide-react";

type Props = {
  organizationId: string;
};

export function SecondMemberNudge({ organizationId }: Props) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  async function handleDismiss() {
    setDismissing(true);
    try {
      await fetch(`/api/v1/organizations/${organizationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: { secondMemberNudge: false } }),
      });
      setDismissed(true);
      router.refresh();
    } catch {
      setDismissing(false);
    }
  }

  if (dismissed) return null;

  return (
    <div className="max-w-2xl squircle flex items-start gap-3 border bg-muted/50 p-4 text-sm">
      <Info className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
      <span className="flex-1">
        You recently added a team member, but all new items are currently
        assigned to you. Update the <strong>default assignee</strong> above,
        or set owners on individual clients and projects.
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 -mt-1.5 -mr-2"
        onClick={handleDismiss}
        disabled={dismissing}
      >
        <X className="size-4" />
        <span className="sr-only">Dismiss</span>
      </Button>
    </div>
  );
}
