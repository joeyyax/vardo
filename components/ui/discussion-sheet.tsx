"use client";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ProjectComments } from "@/components/projects/project-comments";
import { ClientComments } from "@/components/clients/client-comments";

type DiscussionSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "project" | "client";
  entityId: string;
  orgId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function DiscussionSheet({
  open,
  onOpenChange,
  entityType,
  entityId,
  orgId,
  currentUserId,
  onUpdate,
}: DiscussionSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-md w-full flex flex-col gap-0 p-0"
        showCloseButton
      >
        <div className="flex-1 min-h-0 overflow-hidden px-4 pt-4 pb-4">
          {entityType === "project" ? (
            <ProjectComments
              orgId={orgId}
              projectId={entityId}
              currentUserId={currentUserId}
              onUpdate={onUpdate}
            />
          ) : (
            <ClientComments
              orgId={orgId}
              clientId={entityId}
              currentUserId={currentUserId}
              onUpdate={onUpdate}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
