"use client";

import { useState } from "react";
import { format } from "date-fns";
import {
  Mail,
  Paperclip,
  FileText,
  Image,
  CheckCircle2,
  Info,
  Trash2,
  ExternalLink,
  Cloud,
  Building2,
  FolderKanban,
  MessageSquare,
  ListTodo,
  ArrowRightLeft,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { InboxConvertForm } from "./inbox-convert-form";
import { InboxConvertFileForm } from "./inbox-convert-file-form";
import { InboxConvertDiscussionForm } from "./inbox-convert-discussion-form";
import { InboxConvertTaskForm } from "./inbox-convert-task-form";
import { InboxTransferForm } from "./inbox-transfer-form";
import type { InboxItem } from "./types";

type InboxItemDetailProps = {
  orgId: string;
  item: InboxItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onItemUpdated: () => void;
};

export function InboxItemDetail({
  orgId,
  item,
  open,
  onOpenChange,
  onItemUpdated,
}: InboxItemDetailProps) {
  const [convertType, setConvertType] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  async function updateStatus(status: string) {
    setUpdating(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }
      );
      if (!res.ok) throw new Error("Failed to update");
      toast.success(
        status === "discarded"
          ? "Item discarded"
          : status === "informational"
            ? "Marked as informational"
            : "Status updated"
      );
      onItemUpdated();
      onOpenChange(false);
    } catch {
      toast.error("Failed to update item");
    } finally {
      setUpdating(false);
    }
  }

  function handleConverted() {
    setConvertType(null);
    onItemUpdated();
    onOpenChange(false);
    toast.success("Inbox item converted");
  }

  async function handleViewFile(fileId: string) {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/files/${fileId}`
      );
      if (res.ok) {
        const { url } = await res.json();
        window.open(url, "_blank");
      } else {
        toast.error("Failed to get file URL");
      }
    } catch {
      toast.error("Failed to open file");
    }
  }

  const isActionable = item.status === "needs_review";

  const actions = isActionable ? (
    <>
      <IconButton
        icon={Info}
        tooltip="Mark Informational"
        onClick={() => updateStatus("informational")}
        disabled={updating}
      />
      <IconButton
        icon={Trash2}
        tooltip="Discard"
        onClick={() => updateStatus("discarded")}
        disabled={updating}
      />
    </>
  ) : null;

  return (
    <DetailModal
      open={open}
      onOpenChange={onOpenChange}
      title={item.subject || "(no subject)"}
      description={
        <span className="text-xs text-muted-foreground">
          From {item.fromName || item.fromAddress || "Unknown"} &middot;{" "}
          {format(new Date(item.receivedAt), "MMM d, yyyy h:mm a")}
        </span>
      }
      actions={actions}
    >
      <div className="space-y-6">
        {/* Email metadata */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Mail className="size-4 text-muted-foreground" />
            <span className="font-medium">
              {item.fromName || "Unknown sender"}
            </span>
            {item.fromAddress && (
              <span className="text-muted-foreground">
                &lt;{item.fromAddress}&gt;
              </span>
            )}
          </div>
        </div>

        {/* Entity association */}
        {(item.client || item.project) && (
          <div className="flex items-center gap-3 text-sm">
            {item.client && (
              <div className="flex items-center gap-1.5">
                <Building2 className="size-4 text-muted-foreground" />
                <span>{item.client.name}</span>
              </div>
            )}
            {item.project && (
              <div className="flex items-center gap-1.5">
                <FolderKanban className="size-4 text-muted-foreground" />
                <span>{item.project.name}</span>
              </div>
            )}
          </div>
        )}

        {/* Attachments */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Paperclip className="size-4" />
            Attachments ({item.files?.length || 0})
          </h3>
          <div className="space-y-1.5">
            {item.files?.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted/50 cursor-pointer"
                onClick={() => handleViewFile(file.id)}
              >
                <FileIcon mimeType={file.mimeType} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate flex items-center gap-1.5">
                    {file.name}
                    {file.source === "cloud_url" && (
                      <Cloud className="size-3 text-blue-500 shrink-0" />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatFileSize(file.sizeBytes)} &middot;{" "}
                    {file.mimeType}
                    {file.source === "cloud_url" && " \u00b7 from cloud link"}
                  </div>
                </div>
                <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
              </div>
            ))}
          </div>
        </div>

        {/* Status info for non-actionable items */}
        {item.status === "converted" && (
          <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/50 p-3">
            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 className="size-4" />
              <span>
                {item.convertedTo === "expense" && item.convertedExpense
                  ? `Converted to expense: ${item.convertedExpense.description}`
                  : item.convertedTo === "file"
                    ? "Files saved to project"
                    : item.convertedTo === "discussion"
                      ? "Posted as discussion"
                      : item.convertedTo === "task"
                        ? "Converted to task"
                        : "Converted"}
              </span>
            </div>
          </div>
        )}

        {item.status === "informational" && (
          <div className="rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Info className="size-4" />
              <span>Marked as informational — no action needed.</span>
            </div>
          </div>
        )}

        {item.status === "discarded" && (
          <div className="rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Trash2 className="size-4" />
              <span>This item has been discarded.</span>
            </div>
          </div>
        )}

        {/* Conversion actions */}
        {isActionable && (
          <div className="space-y-3">
            <Select
              value={convertType || ""}
              onValueChange={(v) => setConvertType(v || null)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Convert to..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">Expense</SelectItem>
                <SelectItem value="file">Project File</SelectItem>
                <SelectItem value="discussion">Discussion</SelectItem>
                <SelectItem value="task">Task</SelectItem>
                <SelectItem value="transfer">Transfer</SelectItem>
              </SelectContent>
            </Select>

            {convertType === "expense" && (
              <InboxConvertForm
                orgId={orgId}
                item={item}
                onConverted={handleConverted}
                onCancel={() => setConvertType(null)}
              />
            )}
            {convertType === "file" && (
              <InboxConvertFileForm
                orgId={orgId}
                item={item}
                onConverted={handleConverted}
                onCancel={() => setConvertType(null)}
              />
            )}
            {convertType === "discussion" && (
              <InboxConvertDiscussionForm
                orgId={orgId}
                item={item}
                onConverted={handleConverted}
                onCancel={() => setConvertType(null)}
              />
            )}
            {convertType === "task" && (
              <InboxConvertTaskForm
                orgId={orgId}
                item={item}
                onConverted={handleConverted}
                onCancel={() => setConvertType(null)}
              />
            )}
            {convertType === "transfer" && (
              <InboxTransferForm
                orgId={orgId}
                item={item}
                onConverted={handleConverted}
                onCancel={() => setConvertType(null)}
              />
            )}
          </div>
        )}
      </div>
    </DetailModal>
  );
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === "application/pdf") {
    return <FileText className="size-5 text-red-500" />;
  }
  if (mimeType.startsWith("image/")) {
    return <Image className="size-5 text-blue-500" />;
  }
  return <Paperclip className="size-5 text-muted-foreground" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
