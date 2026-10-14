"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { useCancelDeploy } from "./hooks/use-app-actions";

/** Cancel while a deploy is in flight: the app page's toolbar and the Projects panel. */
export function DeployCancel({
  cancel,
  deploymentId,
  onCancelled,
}: {
  cancel: ReturnType<typeof useCancelDeploy>;
  deploymentId?: string;
  onCancelled?: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="pointer-coarse:h-11"
      disabled={cancel.cancelling}
      onClick={() => void cancel.cancelDeploy(deploymentId).then((ok) => ok && onCancelled?.())}
    >
      <X className="mr-1.5 size-3.5" />
      {cancel.cancelling ? "Cancelling..." : "Cancel"}
    </Button>
  );
}
