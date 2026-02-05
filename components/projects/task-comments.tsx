"use client";

import { useState, useEffect, useCallback } from "react";
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
  Eye,
  EyeOff,
  Send,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

type CommentAuthor = {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
};

type Comment = {
  id: string;
  taskId: string;
  authorId: string;
  content: string;
  isShared: boolean;
  sharedAt: string | null;
  sharedBy: string | null;
  createdAt: string;
  updatedAt: string;
  author: CommentAuthor;
  sharedByUser?: CommentAuthor | null;
};

type TaskCommentsProps = {
  orgId: string;
  projectId: string;
  taskId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function TaskComments({
  orgId,
  projectId,
  taskId,
  currentUserId,
  onUpdate,
}: TaskCommentsProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchComments = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/comments`
      );
      if (response.ok) {
        const data = await response.json();
        setComments(data);
      }
    } catch (err) {
      console.error("Error fetching comments:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, taskId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: newComment,
            isShared,
          }),
        }
      );

      if (response.ok) {
        setNewComment("");
        setIsShared(false);
        fetchComments();
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
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/comments/${commentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        }
      );

      if (response.ok) {
        setEditingId(null);
        setEditContent("");
        fetchComments();
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
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/comments/${comment.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isShared: !comment.isShared }),
        }
      );

      if (response.ok) {
        fetchComments();
        toast.success(comment.isShared ? "Comment made private" : "Comment shared with client");
      } else {
        toast.error("Failed to update sharing");
      }
    } catch (err) {
      console.error("Error toggling share:", err);
      toast.error("Failed to update sharing");
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/comments/${deleteId}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        setDeleteId(null);
        fetchComments();
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
      <div className="flex items-center justify-center py-4">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Comments list */}
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          No comments yet. Start the discussion.
        </p>
      ) : (
        <div className="space-y-3">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              currentUserId={currentUserId}
              isEditing={editingId === comment.id}
              editContent={editContent}
              onEditContentChange={setEditContent}
              onStartEdit={() => startEdit(comment)}
              onCancelEdit={cancelEdit}
              onSaveEdit={() => handleEdit(comment.id)}
              onToggleShare={() => handleToggleShare(comment)}
              onDelete={() => setDeleteId(comment.id)}
            />
          ))}
        </div>
      )}

      {/* New comment form */}
      <form onSubmit={handleSubmit} className="space-y-3 pt-2 border-t">
        <div className="relative">
          <Textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            rows={2}
            className="squircle resize-none pr-10"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!newComment.trim() || isSubmitting}
            className="absolute right-2 bottom-2 size-7"
          >
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
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
          <Label htmlFor="share-comment" className="text-xs text-muted-foreground cursor-pointer">
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

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
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
    </div>
  );
}

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
  onDelete: () => void;
}) {
  const isAuthor = comment.authorId === currentUserId;
  const authorName = comment.author.name || comment.author.email.split("@")[0];
  const timeAgo = formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true });
  const wasEdited = comment.createdAt !== comment.updatedAt;

  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2",
        comment.isShared ? "bg-blue-50/50 dark:bg-blue-950/20" : "bg-muted/50"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{authorName}</span>
          <span className="text-muted-foreground text-xs">
            {timeAgo}
            {wasEdited && " (edited)"}
          </span>
          {comment.isShared && (
            <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1">
              <Eye className="size-3" /> Shared
            </span>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6">
              <MoreHorizontal className="size-4" />
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
                  Make internal
                </>
              ) : (
                <>
                  <Eye className="size-4 mr-2" />
                  Share with client
                </>
              )}
            </DropdownMenuItem>
            {isAuthor && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDelete} className="text-destructive">
                  <Trash2 className="size-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isEditing ? (
        <div className="mt-2 space-y-2">
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
            <Button size="sm" variant="outline" onClick={onCancelEdit} className="squircle">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm mt-1 whitespace-pre-wrap">{comment.content}</p>
      )}
    </div>
  );
}

// Summary component for showing comment count in task cards
export function TaskCommentCount({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count === 0) return null;

  return (
    <span className={cn("flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <MessageSquare className="size-3" />
      {count}
    </span>
  );
}
