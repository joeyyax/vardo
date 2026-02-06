"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Send,
  MessageSquare,
  DollarSign,
  Tag,
  CalendarDays,
  FolderOpen,
  ReceiptText,
  ArrowRightLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { eventBus } from "@/lib/events";
import {
  DiscussionPanel,
  DiscussionEmptyState,
  DiscussionAvatar,
  DiscussionActivityItem,
} from "@/components/ui/discussion-panel";

// --- Types ---

type CommentAuthor = {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
};

type Comment = {
  id: string;
  expenseId: string;
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  author: CommentAuthor;
};

type ActivityEntry = {
  id: string;
  actorId: string | null;
  actorType: string | null;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  metadata: unknown;
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
};

type TimelineItem =
  | { type: "comment"; data: Comment; timestamp: string }
  | { type: "activity"; data: ActivityEntry; timestamp: string };

// --- Helpers ---

const FIELD_ICONS: Record<string, React.ReactNode> = {
  amount: <DollarSign className="size-3 text-muted-foreground" />,
  category: <Tag className="size-3 text-muted-foreground" />,
  date: <CalendarDays className="size-3 text-muted-foreground" />,
  project: <FolderOpen className="size-3 text-muted-foreground" />,
  billable: <ReceiptText className="size-3 text-muted-foreground" />,
  status: <ArrowRightLeft className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName = activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this expense";

  if (field === "amount") {
    const oldAmt = activity.oldValue ? `$${(Number(activity.oldValue) / 100).toFixed(2)}` : null;
    const newAmt = activity.newValue ? `$${(Number(activity.newValue) / 100).toFixed(2)}` : null;
    if (oldAmt && newAmt) {
      return (
        <>
          <span className="font-medium">{actorName}</span> changed amount from{" "}
          {oldAmt} to {newAmt}
        </>
      );
    }
  }

  if (field === "billable") {
    const nowBillable = activity.newValue === "true";
    return (
      <>
        <span className="font-medium">{actorName}</span> marked as{" "}
        {nowBillable ? "billable" : "non-billable"}
      </>
    );
  }

  if (field === "status") {
    return (
      <>
        <span className="font-medium">{actorName}</span> changed status to{" "}
        <span className="font-medium">{activity.newValue}</span>
      </>
    );
  }

  // Generic field change
  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

// --- Main Component ---

type ExpenseCommentsProps = {
  orgId: string;
  expenseId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function ExpenseComments({
  orgId,
  expenseId,
  currentUserId,
  onUpdate,
}: ExpenseCommentsProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [commentsRes, activitiesRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/expenses/${expenseId}/comments`),
        fetch(`/api/v1/organizations/${orgId}/expenses/${expenseId}/activities`),
      ]);

      if (commentsRes.ok) {
        setComments(await commentsRes.json());
      }
      if (activitiesRes.ok) {
        setActivities(await activitiesRes.json());
      }
    } catch (err) {
      console.error("Error fetching discussion data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, expenseId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Subscribe to event bus for real-time updates
  useEffect(() => {
    const unsubs = [
      eventBus.on("expense:updated", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
      eventBus.on("expense:comment:created", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
      eventBus.on("expense:comment:updated", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
      eventBus.on("expense:comment:deleted", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [expenseId, fetchData]);

  // Merge comments + activities into a single timeline sorted by timestamp
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...comments.map(
        (c) =>
          ({
            type: "comment",
            data: c,
            timestamp: c.createdAt,
          }) as const
      ),
      ...activities.map(
        (a) =>
          ({
            type: "activity",
            data: a,
            timestamp: a.createdAt,
          }) as const
      ),
    ];
    items.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return items;
  }, [comments, activities]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: newComment }),
        }
      );

      if (response.ok) {
        setNewComment("");
        eventBus.emit("expense:comment:created", { expenseId });
        onUpdate?.();
        toast.success("Comment added");
      } else {
        toast.error("Failed to add comment");
      }
    } catch (err) {
      console.error("Error creating comment:", err);
      toast.error("Failed to add comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = async (commentId: string) => {
    if (!editContent.trim()) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}/comments/${commentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        }
      );

      if (response.ok) {
        setEditingId(null);
        setEditContent("");
        eventBus.emit("expense:comment:updated", { expenseId, commentId });
        toast.success("Comment updated");
      } else {
        toast.error("Failed to update comment");
      }
    } catch (err) {
      console.error("Error updating comment:", err);
      toast.error("Failed to update comment");
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}/comments/${deleteId}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        const deletedId = deleteId;
        setDeleteId(null);
        eventBus.emit("expense:comment:deleted", { expenseId, commentId: deletedId });
        onUpdate?.();
        toast.success("Comment deleted");
      } else {
        toast.error("Failed to delete comment");
      }
    } catch (err) {
      console.error("Error deleting comment:", err);
      toast.error("Failed to delete comment");
    }
  };

  const startEdit = (comment: Comment) => {
    setEditingId(comment.id);
    setEditContent(comment.content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent("");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const commentCount = comments.length;

  const composer = (
    <form onSubmit={handleSubmit}>
      <div className="relative">
        <Textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Write a comment..."
          rows={2}
          className="squircle resize-none pr-10 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          disabled={!newComment.trim() || isSubmitting}
          className="absolute right-1.5 bottom-1.5 size-7 text-muted-foreground hover:text-foreground"
        >
          {isSubmitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
        </Button>
      </div>
    </form>
  );

  return (
    <>
      <DiscussionPanel count={commentCount} composer={composer}>
        {timeline.length === 0 ? (
          <DiscussionEmptyState />
        ) : (
          <div className="space-y-1">
            {timeline.map((item) => {
              if (item.type === "comment") {
                return (
                  <div key={`comment-${item.data.id}`} className="py-1.5">
                    <CommentItem
                      comment={item.data}
                      currentUserId={currentUserId}
                      isEditing={editingId === item.data.id}
                      editContent={editContent}
                      onEditContentChange={setEditContent}
                      onStartEdit={() => startEdit(item.data)}
                      onCancelEdit={cancelEdit}
                      onSaveEdit={() => handleEdit(item.data.id)}
                      onDelete={() => setDeleteId(item.data.id)}
                    />
                  </div>
                );
              }

              const activity = item.data;
              const timeAgo = formatDistanceToNow(
                new Date(activity.createdAt),
                { addSuffix: true }
              );

              return (
                <DiscussionActivityItem
                  key={`activity-${activity.id}`}
                  icon={FIELD_ICONS[activity.field || ""] ?? undefined}
                  timestamp={timeAgo}
                >
                  {formatFieldChange(activity)}
                </DiscussionActivityItem>
              );
            })}
          </div>
        )}
      </DiscussionPanel>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// --- Comment Item ---

function CommentItem({
  comment,
  currentUserId,
  isEditing,
  editContent,
  onEditContentChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  comment: Comment;
  currentUserId: string;
  isEditing: boolean;
  editContent: string;
  onEditContentChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}) {
  const isAuthor = comment.authorId === currentUserId;
  const authorName =
    comment.author.name || comment.author.email.split("@")[0];
  const timeAgo = formatDistanceToNow(new Date(comment.createdAt), {
    addSuffix: true,
  });
  const wasEdited = comment.createdAt !== comment.updatedAt;

  return (
    <div className="group flex gap-3">
      <DiscussionAvatar name={authorName} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{authorName}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {timeAgo}
            {wasEdited && " (edited)"}
          </span>

          {isAuthor && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="squircle">
                <DropdownMenuItem onClick={onStartEdit}>
                  <Pencil className="size-4 mr-2" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive"
                >
                  <Trash2 className="size-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {isEditing ? (
          <div className="mt-1.5 space-y-2">
            <Textarea
              value={editContent}
              onChange={(e) => onEditContentChange(e.target.value)}
              rows={2}
              className="squircle resize-none text-sm"
              autoFocus
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={onSaveEdit} className="squircle">
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onCancelEdit}
                className="squircle"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-wrap">
            {comment.content}
          </p>
        )}
      </div>
    </div>
  );
}

// --- Summary badge for expense rows ---

export function ExpenseCommentCount({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count === 0) return null;

  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs text-muted-foreground",
        className
      )}
    >
      <MessageSquare className="size-3" />
      {count}
    </span>
  );
}
