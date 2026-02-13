"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ProjectComments } from "@/components/projects/project-comments";
import { ClientComments } from "@/components/clients/client-comments";

type DiscussionSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "project" | "client";
  entityId: string;
  entityName: string;
  orgId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function DiscussionSheet({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityName,
  orgId,
  currentUserId,
  onUpdate,
}: DiscussionSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-md w-full flex flex-col"
        showCloseButton
      >
        <SheetHeader>
          <SheetTitle>Discussion</SheetTitle>
          <SheetDescription>{entityName}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
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
