"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type InboxConvertDiscussionFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

function buildDefaultContent(item: InboxItem): string {
  const lines: string[] = [];

  if (item.subject) {
    lines.push(`**${item.subject}**`);
  }

  if (item.fromName || item.fromAddress) {
    const from = item.fromName
      ? `${item.fromName} <${item.fromAddress}>`
      : item.fromAddress;
    lines.push(`From: ${from}`);
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

export function InboxConvertDiscussionForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxConvertDiscussionFormProps) {
  const [content, setContent] = useState(buildDefaultContent(item));
  const [submitting, setSubmitting] = useState(false);

  const targetName = item.project?.name || item.client?.name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!content.trim()) {
      toast.error("Comment content is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert-discussion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: content.trim() }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }

      onConverted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to post comment"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Post as Discussion</h3>

      <div className="grid gap-3">
        {targetName && (
          <p className="text-sm text-muted-foreground">
            Comment will be posted on <span className="font-medium text-foreground">{targetName}</span>
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="convert-discussion-content">Comment</Label>
          <Textarea
            id="convert-discussion-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder="Enter comment content..."
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Post Comment
        </Button>
      </div>
    </form>
  );
}
