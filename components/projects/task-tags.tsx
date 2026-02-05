"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Plus, X, Tag, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Tag = {
  id: string;
  name: string;
  color: string | null;
};

type TaskTagsProps = {
  orgId: string;
  projectId: string;
  taskId: string;
  onUpdate?: () => void;
};

export function TaskTags({ orgId, projectId, taskId, onUpdate }: TaskTagsProps) {
  const [assignedTags, setAssignedTags] = useState<Tag[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const fetchTags = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch assigned tags
      const assignedResponse = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/tags`
      );
      if (assignedResponse.ok) {
        const data = await assignedResponse.json();
        setAssignedTags(data);
      }

      // Fetch all available tags for the org
      const allResponse = await fetch(`/api/v1/organizations/${orgId}/task-tags`);
      if (allResponse.ok) {
        const data = await allResponse.json();
        setAvailableTags(data);
      }
    } catch (err) {
      console.error("Error fetching tags:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, taskId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const assignTag = async (tagId: string) => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/tags`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagId }),
        }
      );

      if (response.ok) {
        const tag = availableTags.find((t) => t.id === tagId);
        if (tag) {
          setAssignedTags((prev) => [...prev, tag]);
          toast.success(`Tag "${tag.name}" added`);
        }
        onUpdate?.();
      } else {
        toast.error("Failed to add tag");
      }
    } catch (err) {
      console.error("Error assigning tag:", err);
      toast.error("Failed to add tag");
    }
  };

  const removeTag = async (tagId: string) => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/tags?tagId=${tagId}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        setAssignedTags((prev) => prev.filter((t) => t.id !== tagId));
        onUpdate?.();
        toast.success("Tag removed");
      } else {
        toast.error("Failed to remove tag");
      }
    } catch (err) {
      console.error("Error removing tag:", err);
      toast.error("Failed to remove tag");
    }
  };

  const assignedIds = new Set(assignedTags.map((t) => t.id));
  const unassignedTags = availableTags.filter((t) => !assignedIds.has(t.id));
  const filteredTags = unassignedTags.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading tags...</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Assigned tags */}
      <div className="flex flex-wrap gap-1.5">
        {assignedTags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full"
            style={{
              backgroundColor: tag.color ? `${tag.color}20` : "#e2e8f0",
              color: tag.color || "#475569",
            }}
          >
            {tag.name}
            <button
              onClick={() => removeTag(tag.id)}
              className="hover:opacity-70"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        {/* Add tag button */}
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
            >
              <Plus className="size-3 mr-1" />
              Add tag
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-2 squircle" align="start">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags..."
              className="h-8 mb-2 squircle"
              autoFocus
            />

            <div className="max-h-[200px] overflow-y-auto space-y-0.5">
              {filteredTags.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {unassignedTags.length === 0
                    ? "All tags assigned"
                    : "No matching tags"}
                </p>
              ) : (
                filteredTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => {
                      assignTag(tag.id);
                      setSearch("");
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left rounded hover:bg-accent transition-colors"
                  >
                    <div
                      className="size-3 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color || "#94a3b8" }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </button>
                ))
              )}
            </div>

            {availableTags.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                No tags created yet.
                <br />
                Create tags in organization settings.
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

// Compact display for task cards
export function TaskTagBadges({
  tags,
  className,
}: {
  tags: Tag[];
  className?: string;
}) {
  if (tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {tags.slice(0, 3).map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full"
          style={{
            backgroundColor: tag.color ? `${tag.color}20` : "#e2e8f0",
            color: tag.color || "#475569",
          }}
        >
          {tag.name}
        </span>
      ))}
      {tags.length > 3 && (
        <span className="text-[10px] text-muted-foreground">
          +{tags.length - 3}
        </span>
      )}
    </div>
  );
}
