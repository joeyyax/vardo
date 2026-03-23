"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import {
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Send,
  MessageSquare,
  Eye,
  EyeOff,
  Pin,
  PinOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { toast } from "@/lib/messenger";
import {
  DiscussionPanel,
  DiscussionEmptyState,
  DiscussionAvatar,
  DiscussionActivityItem,
} from "@/components/ui/discussion-panel";

// --- Shared types ---

type CommentAuthor = {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
};

type Comment = {
  id: string;
  authorId: string;
  content: string;
  isShared: boolean;
  sharedAt: string | null;
  sharedBy: string | null;
  isPinned: boolean;
  pinnedAt: string | null;
  pinnedBy: string | null;
  createdAt: string;
  updatedAt: string;
  author: CommentAuthor;
  sharedByUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  pinnedByUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
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

// --- Default field change formatter ---

function defaultFormatFieldChange(
  activity: ActivityEntry,
  entityLabel: string
): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || `this ${entityLabel}`;

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

// --- Props ---

type EntityCommentsProps = {
  orgId: string;
  entityId: string;
  currentUserId: string;
  onUpdate?: () => void;
  /** Base URL path for comments API, e.g. `/api/v1/organizations/${orgId}/expenses/${id}` */
  apiBasePath: string;
  /** Icon map for activity field names */
  fieldIcons?: Record<string, React.ReactNode>;
  /** Custom formatter for activity entries. Falls back to generic format. */
  formatFieldChange?: (activity: ActivityEntry) => React.ReactNode;
  /** Event bus subscriptions — called on mount, should return unsubscribe functions */
  subscribeToEvents?: (fetchData: () => void) => (() => void)[];
  /** Emit event after creating a comment */
  onCommentCreated?: () => void;
  /** Emit event after updating a comment */
  onCommentUpdated?: (commentId: string) => void;
  /** Emit event after deleting a comment */
  onCommentDeleted?: (commentId: string) => void;
};

function EntityComments({
  orgId,
  entityId,
  currentUserId,
  onUpdate,
  apiBasePath,
  fieldIcons = {},
  formatFieldChange: customFormatFieldChange,
  subscribeToEvents,
  onCommentCreated,
  onCommentUpdated,
  onCommentDeleted,
}: EntityCommentsProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [commentsRes, activitiesRes] = await Promise.all([
        fetch(`${apiBasePath}/comments`),
        fetch(`${apiBasePath}/activities`),
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
  }, [apiBasePath]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Subscribe to event bus for real-time updates
  useEffect(() => {
    if (!subscribeToEvents) return;
    const unsubs = subscribeToEvents(fetchData);
    return () => unsubs.forEach((unsub) => unsub());
  }, [subscribeToEvents, fetchData]);

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
      const response = await fetch(`${apiBasePath}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: newComment,
          isShared,
        }),
      });

      if (response.ok) {
        setNewComment("");
        setIsShared(false);
        fetchData();
        onCommentCreated?.();
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
      const response = await fetch(`${apiBasePath}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });

      if (response.ok) {
        setEditingId(null);
        setEditContent("");
        fetchData();
        onCommentUpdated?.(commentId);
        toast.success("Comment updated");
      } else {
        toast.error("Failed to update comment");
      }
    } catch (err) {
      console.error("Error updating comment:", err);
      toast.error("Failed to update comment");
    }
  };

  const handleToggleShare = async (comment: Comment) => {
    try {
      const response = await fetch(`${apiBasePath}/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isShared: !comment.isShared }),
      });

      if (response.ok) {
        fetchData();
        toast.success(
          comment.isShared
            ? "Comment made private"
            : "Comment shared with client"
        );
      } else {
        toast.error("Failed to update sharing");
      }
    } catch (err) {
      console.error("Error toggling share:", err);
      toast.error("Failed to update sharing");
    }
  };

  const handleTogglePin = async (comment: Comment) => {
    try {
      const response = await fetch(`${apiBasePath}/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPinned: !comment.isPinned }),
      });

      if (response.ok) {
        fetchData();
        toast.success(
          comment.isPinned ? "Comment unpinned" : "Comment pinned"
        );
      } else {
        toast.error("Failed to update pin");
      }
    } catch (err) {
      console.error("Error toggling pin:", err);
      toast.error("Failed to update pin");
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;

    try {
      const response = await fetch(`${apiBasePath}/comments/${deleteId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        const deletedId = deleteId;
        setDeleteId(null);
        fetchData();
        onCommentDeleted?.(deletedId);
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

  const formatActivity = customFormatFieldChange ?? ((a: ActivityEntry) => defaultFormatFieldChange(a, "item"));

  const commentCount = comments.length;
  const pinnedComments = useMemo(
    () => comments.filter((c) => c.isPinned),
    [comments]
  );

  const scrollToComment = (commentId: string) => {
    document
      .querySelector(`[data-comment-id="${commentId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const composer = (
    <form onSubmit={handleSubmit} className="space-y-3">
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

      <div className="flex items-center gap-2">
        <Switch
          id="share-comment"
          checked={isShared}
          onCheckedChange={setIsShared}
          className="scale-75"
        />
        <Label
          htmlFor="share-comment"
          className="text-xs text-muted-foreground cursor-pointer"
        >
          {isShared ? (
            <span className="flex items-center gap-1">
              <Eye className="size-3" /> Visible to client
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <EyeOff className="size-3" /> Internal only
            </span>
          )}
        </Label>
      </div>
    </form>
  );

  return (
    <>
      <DiscussionPanel count={commentCount} composer={composer}>
        {pinnedComments.length > 0 && (
          <div className="mb-3 pb-3 border-b">
            <div className="flex items-center gap-1.5 mb-2">
              <Pin className="size-3 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
                Pinned
              </span>
            </div>
            <div className="space-y-1">
              {pinnedComments.map((comment) => {
                const authorName =
                  comment.author.name ||
                  comment.author.email.split("@")[0];
                return (
                  <button
                    key={`pinned-${comment.id}`}
                    onClick={() => scrollToComment(comment.id)}
                    className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors group/pin"
                  >
                    <Pin className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs line-clamp-2">
                        {comment.content}
                      </p>
                      <span className="text-[10px] text-muted-foreground">
                        {authorName}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePin(comment);
                      }}
                      className="opacity-0 group-hover/pin:opacity-100 transition-opacity shrink-0 p-0.5 hover:bg-muted rounded"
                    >
                      <PinOff className="size-3 text-muted-foreground" />
                    </button>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {timeline.length === 0 ? (
          <DiscussionEmptyState />
        ) : (
          <div className="space-y-1">
            {timeline.map((item) => {
              if (item.type === "comment") {
                return (
                  <div
                    key={`comment-${item.data.id}`}
                    data-comment-id={item.data.id}
                    className="py-1.5"
                  >
                    <CommentItem
                      comment={item.data}
                      currentUserId={currentUserId}
                      isEditing={editingId === item.data.id}
                      editContent={editContent}
                      onEditContentChange={setEditContent}
                      onStartEdit={() => startEdit(item.data)}
                      onCancelEdit={cancelEdit}
                      onSaveEdit={() => handleEdit(item.data.id)}
                      onToggleShare={() => handleToggleShare(item.data)}
                      onTogglePin={() => handleTogglePin(item.data)}
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
                  icon={fieldIcons[activity.field || ""] ?? undefined}
                  timestamp={timeAgo}
                >
                  {formatActivity(activity)}
                </DiscussionActivityItem>
              );
            })}
          </div>
        )}
      </DiscussionPanel>

      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete comment?"
        description="This action cannot be undone."
        onConfirm={handleDelete}
      />
    </>
  );
}

// --- Comment Item (internal) ---

function CommentItem({
  comment,
  currentUserId,
  isEditing,
  editContent,
  onEditContentChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleShare,
  onTogglePin,
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
  onToggleShare: () => void;
  onTogglePin: () => void;
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
          {comment.isPinned && (
            <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 shrink-0">
              <Pin className="size-3" />
            </span>
          )}
          {comment.isShared && (
            <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1 shrink-0">
              <Eye className="size-3" /> Shared
            </span>
          )}

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
              {isAuthor && (
                <DropdownMenuItem onClick={onStartEdit}>
                  <Pencil className="size-4 mr-2" />
                  Edit
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onToggleShare}>
                {comment.isShared ? (
                  <>
                    <EyeOff className="size-4 mr-2" />
                    Make private
                  </>
                ) : (
                  <>
                    <Eye className="size-4 mr-2" />
                    Share with client
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onTogglePin}>
                {comment.isPinned ? (
                  <>
                    <PinOff className="size-4 mr-2" />
                    Unpin
                  </>
                ) : (
                  <>
                    <Pin className="size-4 mr-2" />
                    Pin
                  </>
                )}
              </DropdownMenuItem>
              {isAuthor && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={onDelete}
                    className="text-destructive"
                  >
                    <Trash2 className="size-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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

// --- Comment count badge ---

function CommentCount({
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

export { EntityComments, CommentCount };
export type { EntityCommentsProps, ActivityEntry };
