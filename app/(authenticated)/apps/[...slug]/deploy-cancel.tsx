"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { useCancelDeploy } from "./hooks/use-app-actions";

/** The toolbar's Cancel while a deploy is in flight. */
export function DeployCancel({ cancel }: { cancel: ReturnType<typeof useCancelDeploy> }) {
  return (
    <Button size="sm" variant="outline" className="pointer-coarse:h-10" disabled={cancel.cancelling} onClick={() => void cancel.cancelDeploy()}>
      <X className="mr-1.5 size-3.5" />
      {cancel.cancelling ? "Cancelling..." : "Cancel"}
    </Button>
  );
}
