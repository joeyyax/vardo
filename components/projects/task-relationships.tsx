"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Ban,
  Link as LinkIcon,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { type TaskStatus, TASK_STATUS_LABELS, TASK_STATUS_COLORS } from "./task-dialog";

type RelatedTask = {
  id: string;
  name: string;
  status: TaskStatus | null;
  projectId?: string;
};

type Relationship = {
  id: string;
  type: "blocked_by" | "related_to";
  task: RelatedTask;
  createdAt: string;
};

type TaskRelationshipsProps = {
  orgId: string;
  projectId: string;
  taskId: string;
  onUpdate?: () => void;
};

export function TaskRelationships({
  orgId,
  projectId,
  taskId,
  onUpdate,
}: TaskRelationshipsProps) {
  const [blockedBy, setBlockedBy] = useState<Relationship[]>([]);
  const [blocking, setBlocking] = useState<Relationship[]>([]);
  const [relatedTo, setRelatedTo] = useState<Relationship[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addType, setAddType] = useState<"blocked_by" | "related_to">("blocked_by");

  const fetchRelationships = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/relationships`
      );
      if (response.ok) {
        const data = await response.json();
        setBlockedBy(data.blockedBy || []);
        setBlocking(data.blocking || []);
        setRelatedTo([...(data.relatedTo || []), ...(data.relatedFrom || [])]);
      }
    } catch (err) {
      console.error("Error fetching relationships:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, taskId]);

  useEffect(() => {
    fetchRelationships();
  }, [fetchRelationships]);

  const handleRemove = async (relationshipId: string) => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/relationships/${relationshipId}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        toast.success("Relationship removed");
        fetchRelationships();
        onUpdate?.();
      } else {
        toast.error("Failed to remove relationship");
      }
    } catch (err) {
      console.error("Error removing relationship:", err);
      toast.error("Failed to remove relationship");
    }
  };

  const handleAddSuccess = () => {
    fetchRelationships();
    setAddDialogOpen(false);
    onUpdate?.();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasBlockers = blockedBy.length > 0;
  const hasRelationships = blockedBy.length > 0 || blocking.length > 0 || relatedTo.length > 0;

  return (
    <div className="space-y-4">
      {/* Blockers section */}
      {blockedBy.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
            <Ban className="size-4" />
            Blocked by
          </div>
          <div className="space-y-1">
            {blockedBy.map((rel) => (
              <RelationshipRow
                key={rel.id}
                relationship={rel}
                onRemove={() => handleRemove(rel.id)}
                variant="blocker"
              />
            ))}
          </div>
        </div>
      )}

      {/* Blocking section */}
      {blocking.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <AlertCircle className="size-4" />
            Blocking
          </div>
          <div className="space-y-1">
            {blocking.map((rel) => (
              <RelationshipRow
                key={rel.id}
                relationship={rel}
                onRemove={() => handleRemove(rel.id)}
                variant="blocking"
              />
            ))}
          </div>
        </div>
      )}

      {/* Related section */}
      {relatedTo.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <LinkIcon className="size-4" />
            Related
          </div>
          <div className="space-y-1">
            {relatedTo.map((rel) => (
              <RelationshipRow
                key={rel.id}
                relationship={rel}
                onRemove={() => handleRemove(rel.id)}
                variant="related"
              />
            ))}
          </div>
        </div>
      )}

      {/* Add button */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAddType("blocked_by");
            setAddDialogOpen(true);
          }}
          className="squircle"
        >
          <Ban className="size-3" />
          Add Blocker
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAddType("related_to");
            setAddDialogOpen(true);
          }}
          className="squircle"
        >
          <LinkIcon className="size-3" />
          Add Related
        </Button>
      </div>

      {/* Add relationship dialog */}
      <AddRelationshipDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        orgId={orgId}
        projectId={projectId}
        taskId={taskId}
        type={addType}
        onSuccess={handleAddSuccess}
      />
    </div>
  );
}

function RelationshipRow({
  relationship,
  onRemove,
  variant,
}: {
  relationship: Relationship;
  onRemove: () => void;
  variant: "blocker" | "blocking" | "related";
}) {
  const { task } = relationship;
  const isResolved = task.status === "done";

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm",
        variant === "blocker" && !isResolved && "bg-amber-50 dark:bg-amber-950/30",
        variant === "blocker" && isResolved && "bg-muted/50",
        variant === "blocking" && "bg-muted/50",
        variant === "related" && "bg-muted/50"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isResolved ? (
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        ) : task.status ? (
          <div
            className={cn(
              "size-2 rounded-full shrink-0",
              TASK_STATUS_COLORS[task.status].split(" ")[0]
            )}
          />
        ) : (
          <div className="size-2 rounded-full bg-slate-300 shrink-0" />
        )}
        <span className={cn("truncate", isResolved && "line-through text-muted-foreground")}>
          {task.name}
        </span>
        {task.status && (
          <span className="text-xs text-muted-foreground">
            ({TASK_STATUS_LABELS[task.status]})
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="size-6 shrink-0"
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

function AddRelationshipDialog({
  open,
  onOpenChange,
  orgId,
  projectId,
  taskId,
  type,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  projectId: string;
  taskId: string;
  type: "blocked_by" | "related_to";
  onSuccess: () => void;
}) {
  const [tasks, setTasks] = useState<RelatedTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tasks for the project (could expand to all org tasks)
  useEffect(() => {
    if (!open) return;

    const fetchTasks = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/tasks?hasStatus=true`
        );
        if (response.ok) {
          const data = await response.json();
          // Filter out current task
          setTasks(data.filter((t: RelatedTask) => t.id !== taskId));
        }
      } catch (err) {
        console.error("Error fetching tasks:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchTasks();
    setSelectedTaskId("");
    setSearchQuery("");
    setError(null);
  }, [open, orgId, projectId, taskId]);

  const filteredTasks = tasks.filter((t) =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTaskId) return;

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/relationships`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetTaskId: selectedTaskId,
            type,
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to add relationship");
      }

      toast.success(type === "blocked_by" ? "Blocker added" : "Related task linked");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {type === "blocked_by" ? "Add Blocker" : "Add Related Task"}
            </DialogTitle>
            <DialogDescription>
              {type === "blocked_by"
                ? "This task cannot be completed until the blocker is resolved."
                : "Link a related task for reference."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-6">
            <div className="grid gap-2">
              <Label htmlFor="task-search">Search tasks</Label>
              <Input
                id="task-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Type to search..."
                className="squircle"
              />
            </div>

            <div className="grid gap-2">
              <Label>Select task</Label>
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : filteredTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No tasks found
                </p>
              ) : (
                <div className="max-h-[200px] overflow-y-auto border rounded-md">
                  {filteredTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors",
                        selectedTaskId === task.id && "bg-accent"
                      )}
                    >
                      {task.status ? (
                        <div
                          className={cn(
                            "size-2 rounded-full shrink-0",
                            TASK_STATUS_COLORS[task.status].split(" ")[0]
                          )}
                        />
                      ) : (
                        <div className="size-2 rounded-full bg-slate-300 shrink-0" />
                      )}
                      <span className="truncate">{task.name}</span>
                      {task.status && (
                        <span className="text-xs text-muted-foreground ml-auto">
                          {TASK_STATUS_LABELS[task.status]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!selectedTaskId || isSaving}
              className="squircle"
            >
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              {type === "blocked_by" ? "Add Blocker" : "Add Related"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
