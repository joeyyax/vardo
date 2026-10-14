"use client";

import { useState } from "react";
import { ChevronDown, ChevronsUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import type { DeployView } from "@/lib/ui/deploy-wait";
import { useBumpDeploy, type useCancelDeploy } from "./hooks/use-app-actions";

/** Whether a deploy is waiting in a line it can be moved to the front of. */
export function canStartNext(view: DeployView | null): boolean {
  return !!view && (view.word === "Queued" || view.held === "build");
}

/** The toolbar's Cancel while a deploy is in flight, with Start next in its menu for instance admins while it waits in line. */
export function DeployCancel({
  orgId,
  appId,
  cancel,
  view,
  deploymentId,
  instanceAdmin,
}: {
  orgId: string;
  appId: string;
  cancel: ReturnType<typeof useCancelDeploy>;
  view: DeployView | null;
  /** The deploy in flight, when the page knows it. */
  deploymentId?: string;
  instanceAdmin: boolean;
}) {
  const { bumping, bumpDeploy } = useBumpDeploy(orgId, appId);
  const [confirm, setConfirm] = useState(false);
  const menu = instanceAdmin && canStartNext(view);
  const cancelButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={cancel.cancelling}
      onClick={() => void cancel.cancelDeploy()}
      className={menu ? "rounded-r-none" : undefined}
    >
      <X className="mr-1.5 size-3.5" />
      {cancel.cancelling ? "Cancelling..." : "Cancel"}
    </Button>
  );
  if (!menu) return cancelButton;

  return (
    <div className="flex items-center">
      {cancelButton}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="-ml-px rounded-l-none px-2" aria-label="More deploy actions">
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={bumping} onClick={() => setConfirm(true)}>
            <ChevronsUp className="mr-2 size-4" />
            Start next
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDeleteDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Start next"
        description="Move this deploy to the front of the line?"
        confirmLabel="Start next"
        loadingLabel="Moving..."
        variant="default"
        loading={bumping}
        onConfirm={async () => {
          if (await bumpDeploy(deploymentId)) setConfirm(false);
        }}
      />
    </div>
  );
}
