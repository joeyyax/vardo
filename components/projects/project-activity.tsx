"use client";

import { useState, useEffect, useCallback } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Activity,
  CheckCircle2,
  Edit,
  Eye,
  EyeOff,
  File,
  FileText,
  Loader2,
  MessageSquare,
  MoreVertical,
  RefreshCw,
  Send,
  Trash2,
  UserPlus,
  ArrowRight,
  ListTodo,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ActivityActor = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

type ActivityMetadata = {
  fromStage?: string;
  toStage?: string;
  taskId?: string;
  taskName?: string;
  fromStatus?: string;
  toStatus?: string;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  invitationId?: string;
  inviteeEmail?: string;
  inviteeRole?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  documentId?: string;
  documentTitle?: string;
  documentType?: string;
};

type ProjectActivity = {
  id: string;
  projectId: string;
  type: string;
  actorId: string | null;
  actorType: string;
  content: string | null;
  metadata: ActivityMetadata;
  isPublic: boolean;
  createdAt: string;
  actor?: ActivityActor | null;
};

type ProjectActivityProps = {
  orgId: string;
  projectId: string;
};

// Activity type configuration
const ACTIVITY_CONFIG: Record<string, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  color: string;
  getDescription: (metadata: ActivityMetadata) => string;
}> = {
  note: {
    icon: MessageSquare,
    label: "Note",
    color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900",
    getDescription: () => "added a note",
  },
  stage_change: {
    icon: ArrowRight,
    label: "Stage Change",
    color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900",
    getDescription: (m) => `moved project to ${m.toStage}`,
  },
  task_created: {
    icon: ListTodo,
    label: "Task Created",
    color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900",
    getDescription: (m) => `created task "${m.taskName}"`,
  },
  task_status_changed: {
    icon: RefreshCw,
    label: "Task Updated",
    color: "text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900",
    getDescription: (m) => `moved "${m.taskName}" to ${m.toStatus}`,
  },
  task_completed: {
    icon: CheckCircle2,
    label: "Task Completed",
    color: "text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900",
    getDescription: (m) => `completed "${m.taskName}"`,
  },
  file_uploaded: {
    icon: File,
    label: "File Uploaded",
    color: "text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900",
    getDescription: (m) => `uploaded "${m.fileName}"`,
  },
  file_deleted: {
    icon: Trash2,
    label: "File Deleted",
    color: "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900",
    getDescription: (m) => `deleted "${m.fileName}"`,
  },
  invitation_sent: {
    icon: Send,
    label: "Invitation Sent",
    color: "text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900",
    getDescription: (m) => `invited ${m.inviteeEmail}`,
  },
  invitation_accepted: {
    icon: UserPlus,
    label: "Client Joined",
    color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900",
    getDescription: (m) => `${m.inviteeEmail} joined as ${m.inviteeRole}`,
  },
  invoice_created: {
    icon: FileText,
    label: "Invoice Created",
    color: "text-slate-600 bg-slate-100 dark:text-slate-400 dark:bg-slate-800",
    getDescription: (m) => `created invoice ${m.invoiceNumber}`,
  },
  invoice_sent: {
    icon: Send,
    label: "Invoice Sent",
    color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900",
    getDescription: (m) => `sent invoice ${m.invoiceNumber}`,
  },
};

export function ProjectActivity({ orgId, projectId }: ProjectActivityProps) {
  const [activities, setActivities] = useState<ProjectActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const [noteIsPublic, setNoteIsPublic] = useState(false);
  const [editingActivity, setEditingActivity] = useState<ProjectActivity | null>(null);
  const [deleteActivity, setDeleteActivity] = useState<ProjectActivity | null>(null);

  const fetchActivities = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/activities?limit=50`
      );
      if (response.ok) {
        const data = await response.json();
        setActivities(data);
      }
    } catch (err) {
      console.error("Error fetching activities:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  async function handleAddNote() {
    if (!noteContent.trim()) return;

    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/activities`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: noteContent,
            isPublic: noteIsPublic,
          }),
        }
      );

      if (response.ok) {
        setNoteContent("");
        setNoteIsPublic(false);
        fetchActivities();
        toast.success("Note added");
      } else {
        toast.error("Failed to add note");
      }
    } catch {
      toast.error("Failed to add note");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUpdateNote() {
    if (!editingActivity || !noteContent.trim()) return;

    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/activities/${editingActivity.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: noteContent,
            isPublic: noteIsPublic,
          }),
        }
      );

      if (response.ok) {
        setEditingActivity(null);
        setNoteContent("");
        setNoteIsPublic(false);
        fetchActivities();
        toast.success("Note updated");
      } else {
        toast.error("Failed to update note");
      }
    } catch {
      toast.error("Failed to update note");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteNote() {
    if (!deleteActivity) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/activities/${deleteActivity.id}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        fetchActivities();
        toast.success("Note deleted");
      } else {
        toast.error("Failed to delete note");
      }
    } catch {
      toast.error("Failed to delete note");
    } finally {
      setDeleteActivity(null);
    }
  }

  function startEditing(activity: ProjectActivity) {
    setEditingActivity(activity);
    setNoteContent(activity.content || "");
    setNoteIsPublic(activity.isPublic);
  }

  function cancelEditing() {
    setEditingActivity(null);
    setNoteContent("");
    setNoteIsPublic(false);
  }

  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-5" />
          Activity
        </CardTitle>
        <CardDescription>Project timeline and notes</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add note form */}
        <div className="space-y-3">
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            placeholder="Add a note..."
            rows={3}
            className="squircle resize-none"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id="note-public"
                checked={noteIsPublic}
                onCheckedChange={setNoteIsPublic}
                size="sm"
              />
              <Label
                htmlFor="note-public"
                className="text-sm text-muted-foreground cursor-pointer flex items-center gap-1"
              >
                {noteIsPublic ? (
                  <>
                    <Eye className="size-3" /> Visible to clients
                  </>
                ) : (
                  <>
                    <EyeOff className="size-3" /> Internal only
                  </>
                )}
              </Label>
            </div>
            <div className="flex gap-2">
              {editingActivity && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={cancelEditing}
                  disabled={isSubmitting}
                  className="squircle"
                >
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                onClick={editingActivity ? handleUpdateNote : handleAddNote}
                disabled={!noteContent.trim() || isSubmitting}
                className="squircle"
              >
                {isSubmitting && <Loader2 className="size-4 animate-spin" />}
                {editingActivity ? "Update" : "Add Note"}
              </Button>
            </div>
          </div>
        </div>

        {/* Activity timeline */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : activities.length === 0 ? (
          <div className="text-center py-8">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <Activity className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">No activity yet</p>
          </div>
        ) : (
          <div className="space-y-4">
            {activities.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                onEdit={() => startEditing(activity)}
                onDelete={() => setDeleteActivity(activity)}
              />
            ))}
          </div>
        )}
      </CardContent>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteActivity} onOpenChange={() => setDeleteActivity(null)}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this note. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteNote}
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ActivityItem({
  activity,
  onEdit,
  onDelete,
}: {
  activity: ProjectActivity;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const config = ACTIVITY_CONFIG[activity.type] || {
    icon: Activity,
    label: activity.type,
    color: "text-slate-600 bg-slate-100",
    getDescription: () => activity.type,
  };

  const Icon = config.icon;
  const actorName = activity.actor?.name || activity.actor?.email || "System";
  const timeAgo = formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true });

  return (
    <div className="flex gap-3">
      {/* Icon */}
      <div
        className={cn(
          "flex size-8 items-center justify-center rounded-full shrink-0",
          config.color
        )}
      >
        <Icon className="size-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm">
              <span className="font-medium">{actorName}</span>{" "}
              <span className="text-muted-foreground">
                {config.getDescription(activity.metadata)}
              </span>
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
              <span>{timeAgo}</span>
              {activity.isPublic && (
                <span className="flex items-center gap-1">
                  <Eye className="size-3" /> Public
                </span>
              )}
            </div>
          </div>

          {/* Actions for notes */}
          {activity.type === "note" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6">
                  <MoreVertical className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="squircle">
                <DropdownMenuItem onClick={onEdit}>
                  <Edit className="size-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Note content */}
        {activity.type === "note" && activity.content && (
          <div className="mt-2 p-3 rounded-lg bg-muted/50 text-sm whitespace-pre-wrap">
            {activity.content}
          </div>
        )}
      </div>
    </div>
  );
}
