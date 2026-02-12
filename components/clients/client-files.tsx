"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CheckCircle2,
  Download,
  Eye,
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image,
  Loader2,
  Music,
  Send,
  Video,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { UnifiedFile, FileKind } from "@/lib/types/project-files";

// ─── Props ──────────────────────────────────────────────────────────────────

type ClientFilesProps = {
  orgId: string;
  clientId: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith("image/")) return <Image className={className} />;
  if (mimeType.startsWith("video/")) return <Video className={className} />;
  if (mimeType.startsWith("audio/")) return <Music className={className} />;
  if (mimeType.includes("pdf")) return <FileText className={className} />;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel"))
    return <FileSpreadsheet className={className} />;
  if (
    mimeType.includes("zip") ||
    mimeType.includes("tar") ||
    mimeType.includes("compressed")
  )
    return <FileArchive className={className} />;
  if (
    mimeType.includes("json") ||
    mimeType.includes("javascript") ||
    mimeType.includes("html") ||
    mimeType.includes("css")
  )
    return <FileCode className={className} />;
  return <File className={className} />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const DOC_STATUS_CONFIG = {
  draft: { icon: FileText, label: "Draft", color: "text-muted-foreground" },
  sent: { icon: Send, label: "Sent", color: "text-blue-600 dark:text-blue-400" },
  viewed: { icon: Eye, label: "Viewed", color: "text-amber-600 dark:text-amber-400" },
  accepted: { icon: CheckCircle2, label: "Accepted", color: "text-green-600 dark:text-green-400" },
  declined: { icon: XCircle, label: "Declined", color: "text-red-600 dark:text-red-400" },
} as const;

const DOC_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  proposal: {
    bg: "bg-blue-100 dark:bg-blue-900",
    text: "text-blue-600 dark:text-blue-400",
  },
  contract: {
    bg: "bg-purple-100 dark:bg-purple-900",
    text: "text-purple-600 dark:text-purple-400",
  },
  change_order: {
    bg: "bg-orange-100 dark:bg-orange-900",
    text: "text-orange-600 dark:text-orange-400",
  },
  orientation: {
    bg: "bg-teal-100 dark:bg-teal-900",
    text: "text-teal-600 dark:text-teal-400",
  },
  addendum: {
    bg: "bg-gray-100 dark:bg-gray-800",
    text: "text-gray-600 dark:text-gray-400",
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ClientFiles({ orgId, clientId }: ClientFilesProps) {
  const router = useRouter();

  const [files, setFiles] = useState<UnifiedFile[]>([]);
  const [counts, setCounts] = useState({ total: 0, uploaded: 0, generated: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<FileKind | "all">("all");

  const fetchFiles = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (kindFilter !== "all") params.set("kind", kindFilter);
      const qs = params.toString();

      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${clientId}/files${qs ? `?${qs}` : ""}`
      );
      if (response.ok) {
        const data = await response.json();
        setFiles(data.files);
        setCounts(data.counts);
      }
    } catch (err) {
      console.error("Error fetching client files:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, clientId, kindFilter]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // ── Actions ────────────────────────────────────────────────────────────

  async function handleDownload(file: UnifiedFile) {
    if (!file.projectId) return;
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${file.projectId}/files/${file.sourceId}?action=download`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.downloadUrl) {
          window.open(data.downloadUrl, "_blank");
        } else {
          toast.error("File storage is not configured");
        }
      }
    } catch {
      toast.error("Failed to download file");
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <File className="size-5" />
          Files
        </CardTitle>
        <CardDescription>Across all projects</CardDescription>
      </CardHeader>

      <CardContent>
        {/* Filter toggles */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Badge
            variant={kindFilter === "all" ? "default" : "outline"}
            className="squircle cursor-pointer"
            onClick={() => setKindFilter("all")}
          >
            All{counts.total > 0 ? ` (${counts.total})` : ""}
          </Badge>
          <Badge
            variant={kindFilter === "generated" ? "default" : "outline"}
            className="squircle cursor-pointer"
            onClick={() => setKindFilter("generated")}
          >
            Documents{counts.generated > 0 ? ` (${counts.generated})` : ""}
          </Badge>
          <Badge
            variant={kindFilter === "uploaded" ? "default" : "outline"}
            className="squircle cursor-pointer"
            onClick={() => setKindFilter("uploaded")}
          >
            Uploads{counts.uploaded > 0 ? ` (${counts.uploaded})` : ""}
          </Badge>
        </div>

        {/* File list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <div className="text-center py-8">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <File className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {kindFilter !== "all"
                ? `No ${kindFilter === "generated" ? "documents" : "uploads"} yet`
                : "No files yet"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((file) =>
              file.kind === "generated" ? (
                <ClientDocumentRow
                  key={file.id}
                  file={file}
                  onClick={() =>
                    router.push(
                      `/projects/${file.projectId}/documents/${file.sourceId}`
                    )
                  }
                />
              ) : (
                <ClientUploadedFileRow
                  key={file.id}
                  file={file}
                  onDownload={() => handleDownload(file)}
                />
              )
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Document Row ─────────────────────────────────────────────────────────

function ClientDocumentRow({
  file,
  onClick,
}: {
  file: UnifiedFile;
  onClick: () => void;
}) {
  const docType = file.documentType || "proposal";
  const status = file.documentStatus || "draft";
  const config = DOC_STATUS_CONFIG[status];
  const StatusIcon = config.icon;
  const colors = DOC_TYPE_COLORS[docType] || DOC_TYPE_COLORS.proposal;

  return (
    <div
      className="flex items-center justify-between gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={cn(
            "flex size-8 items-center justify-center rounded-full shrink-0",
            colors.bg
          )}
        >
          <FileText className={cn("size-4", colors.text)} />
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{file.name}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="capitalize">
              {docType === "change_order" ? "Change Order" : docType}
            </span>
            <span>&middot;</span>
            <StatusIcon className={cn("size-3", config.color)} />
            <span className={config.color}>{config.label}</span>
            {status !== "draft" && file.sentAt && (
              <>
                <span>&middot;</span>
                <span>
                  Sent{" "}
                  {formatDistanceToNow(new Date(file.sentAt), {
                    addSuffix: true,
                  })}
                </span>
              </>
            )}
            {file.projectName && (
              <>
                <span>&middot;</span>
                <span className="truncate">{file.projectName}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Uploaded File Row ──────────────────────────────────────────────────────

function ClientUploadedFileRow({
  file,
  onDownload,
}: {
  file: UnifiedFile;
  onDownload: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted shrink-0">
          <FileIcon mimeType={file.mimeType || "application/octet-stream"} className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{file.name}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {file.sizeBytes && <span>{formatFileSize(file.sizeBytes)}</span>}
            {file.projectName && (
              <>
                <span>&middot;</span>
                <span className="truncate">{file.projectName}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <button
        onClick={onDownload}
        className="shrink-0 p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        title="Download"
      >
        <Download className="size-4" />
      </button>
    </div>
  );
}
