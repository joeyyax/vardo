"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image,
  Loader2,
  MoreVertical,
  Music,
  Plus,
  Send,
  Tag,
  Trash2,
  Upload,
  Video,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TemplateWizard } from "@/components/documents/template-wizard";
import type { UnifiedFile, FileKind } from "@/lib/types/project-files";

// ─── Props ──────────────────────────────────────────────────────────────────

type ProjectFilesProps = {
  orgId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  organizationName: string;
  suggestedTemplateId?: string;
  /** Stage capabilities — controls which actions are available */
  canUpload?: boolean;
  canCreateDocuments?: boolean;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("video/")) return Video;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("pdf")) return FileText;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel"))
    return FileSpreadsheet;
  if (
    mimeType.includes("zip") ||
    mimeType.includes("tar") ||
    mimeType.includes("compressed")
  )
    return FileArchive;
  if (
    mimeType.includes("json") ||
    mimeType.includes("javascript") ||
    mimeType.includes("html") ||
    mimeType.includes("css")
  )
    return FileCode;
  return File;
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

export function ProjectFiles({
  orgId,
  projectId,
  projectName,
  clientName,
  organizationName,
  suggestedTemplateId,
  canUpload = true,
  canCreateDocuments = true,
}: ProjectFilesProps) {
  const router = useRouter();

  // Data state
  const [files, setFiles] = useState<UnifiedFile[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [counts, setCounts] = useState({ total: 0, uploaded: 0, generated: 0 });
  const [isLoading, setIsLoading] = useState(true);

  // Filter state
  const [kindFilter, setKindFilter] = useState<FileKind | "all">("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Dialog state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedFile | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardDocType, setWizardDocType] = useState<
    "proposal" | "contract" | "change_order"
  >("proposal");

  // Expanded superseded versions
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // ── Data fetching ──────────────────────────────────────────────────────

  const fetchFiles = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (selectedTag) params.set("tag", selectedTag);
      const qs = params.toString();

      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/unified${qs ? `?${qs}` : ""}`
      );
      if (response.ok) {
        const data = await response.json();
        setFiles(data.files);
        setAllTags(data.tags);
        setCounts(data.counts);
      }
    } catch (err) {
      console.error("Error fetching files:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, kindFilter, selectedTag]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // Listen for open-document-wizard events from StageGuidance
  useEffect(() => {
    function handleOpenWizard(e: Event) {
      const detail = (e as CustomEvent).detail as {
        type: "proposal" | "contract" | "change_order";
        suggestedTemplateId?: string;
      };
      setWizardDocType(detail.type);
      setWizardOpen(true);
    }
    window.addEventListener("open-document-wizard", handleOpenWizard);
    return () =>
      window.removeEventListener("open-document-wizard", handleOpenWizard);
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────

  async function handleDownload(file: UnifiedFile) {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/${file.sourceId}?action=download`
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

  async function handleView(file: UnifiedFile) {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/${file.sourceId}?action=view`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.viewUrl) {
          window.open(data.viewUrl, "_blank");
        } else {
          toast.error("File storage is not configured");
        }
      }
    } catch {
      toast.error("Failed to view file");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;

    const endpoint =
      deleteTarget.sourceTable === "project_files"
        ? `/api/v1/organizations/${orgId}/projects/${projectId}/files/${deleteTarget.sourceId}`
        : `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${deleteTarget.sourceId}`;

    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      if (response.ok) {
        toast.success(
          deleteTarget.kind === "uploaded" ? "File deleted" : "Document deleted"
        );
        fetchFiles();
      } else {
        const data = await response.json();
        toast.error(data.error || "Failed to delete");
      }
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleteTarget(null);
    }
  }

  function copyPublicLink(file: UnifiedFile) {
    if (!file.publicToken) return;
    const url = `${window.location.origin}/d/${file.publicToken}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Show actions ───────────────────────────────────────────────────────

  const showActions = canUpload || canCreateDocuments;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Card className="squircle">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <File className="size-5" />
              Files
            </CardTitle>
            <CardDescription>
              Attachments, proposals, contracts, and more
            </CardDescription>
          </div>
          {showActions && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="squircle">
                  <Plus className="size-4" />
                  Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="squircle">
                {canUpload && (
                  <DropdownMenuItem
                    onClick={() => setUploadDialogOpen(true)}
                  >
                    <Upload className="size-4" />
                    Upload File
                  </DropdownMenuItem>
                )}
                {canUpload && canCreateDocuments && <DropdownMenuSeparator />}
                {canCreateDocuments && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        setWizardDocType("proposal");
                        setWizardOpen(true);
                      }}
                    >
                      <FileText className="size-4 text-blue-600" />
                      New Proposal
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setWizardDocType("contract");
                        setWizardOpen(true);
                      }}
                    >
                      <FileText className="size-4 text-purple-600" />
                      New Contract
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setWizardDocType("change_order");
                        setWizardOpen(true);
                      }}
                    >
                      <FileText className="size-4 text-orange-600" />
                      New Change Order
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
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

          {/* Tag filters */}
          {allTags.length > 0 && (
            <>
              <span className="text-muted-foreground text-xs">|</span>
              {allTags.map((tag) => (
                <Badge
                  key={tag}
                  variant={selectedTag === tag ? "default" : "outline"}
                  className="squircle cursor-pointer"
                  onClick={() =>
                    setSelectedTag(selectedTag === tag ? null : tag)
                  }
                >
                  <Tag className="size-3 mr-1" />
                  {tag}
                </Badge>
              ))}
            </>
          )}
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
            {files.map((file) => (
              <div key={file.id}>
                {file.kind === "generated" ? (
                  <DocumentRow
                    file={file}
                    projectId={projectId}
                    onCopyLink={() => copyPublicLink(file)}
                    onDelete={() => setDeleteTarget(file)}
                    onClick={() =>
                      router.push(
                        `/projects/${projectId}/documents/${file.sourceId}`
                      )
                    }
                  />
                ) : (
                  <UploadedFileRow
                    file={file}
                    onView={() => handleView(file)}
                    onDownload={() => handleDownload(file)}
                    onDelete={() => setDeleteTarget(file)}
                    hasVersions={
                      !!file.previousVersions &&
                      file.previousVersions.length > 0
                    }
                    isExpanded={expandedIds.has(file.id)}
                    onToggleExpand={() => toggleExpanded(file.id)}
                  />
                )}

                {/* Superseded versions */}
                {file.previousVersions &&
                  file.previousVersions.length > 0 &&
                  expandedIds.has(file.id) && (
                    <div className="ml-6 mt-1 space-y-1 border-l-2 border-muted pl-3">
                      {file.previousVersions.map((prev) => (
                        <UploadedFileRow
                          key={prev.id}
                          file={prev}
                          onView={() => handleView(prev)}
                          onDownload={() => handleDownload(prev)}
                          onDelete={() => setDeleteTarget(prev)}
                          isSuperseded
                        />
                      ))}
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Upload dialog */}
      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        orgId={orgId}
        projectId={projectId}
        existingTags={allTags}
        existingFiles={files.filter((f) => f.kind === "uploaded")}
        onSuccess={fetchFiles}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
      >
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.kind === "uploaded" ? "file" : "document"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.name}&rdquo;.
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

      {/* Template Wizard */}
      <TemplateWizard
        orgId={orgId}
        projectId={projectId}
        projectName={projectName}
        clientName={clientName}
        organizationName={organizationName}
        documentType={wizardDocType}
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open);
          if (!open) fetchFiles();
        }}
        suggestedTemplateId={suggestedTemplateId}
      />
    </Card>
  );
}

// ─── Document Row ─────────────────────────────────────────────────────────

function DocumentRow({
  file,
  projectId,
  onCopyLink,
  onDelete,
  onClick,
}: {
  file: UnifiedFile;
  projectId: string;
  onCopyLink: () => void;
  onDelete: () => void;
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
          </div>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          asChild
          onClick={(e) => e.stopPropagation()}
        >
          <Button variant="ghost" size="icon" className="size-8 shrink-0">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="squircle">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
          >
            <Eye className="size-4" />
            {status === "draft" ? "Edit" : "View"}
          </DropdownMenuItem>
          {file.publicToken && status !== "draft" && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onCopyLink();
              }}
            >
              <Copy className="size-4" />
              Copy Link
            </DropdownMenuItem>
          )}
          {status === "draft" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Uploaded File Row ──────────────────────────────────────────────────────

function UploadedFileRow({
  file,
  onView,
  onDownload,
  onDelete,
  hasVersions,
  isExpanded,
  onToggleExpand,
  isSuperseded,
}: {
  file: UnifiedFile;
  onView: () => void;
  onDownload: () => void;
  onDelete: () => void;
  hasVersions?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  isSuperseded?: boolean;
}) {
  const FileIcon = getFileIcon(file.mimeType || "application/octet-stream");

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 p-3 rounded-lg border hover:bg-accent/50 transition-colors",
        isSuperseded && "opacity-60"
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        {hasVersions && onToggleExpand ? (
          <button
            onClick={onToggleExpand}
            className="flex size-10 items-center justify-center rounded-lg bg-muted shrink-0 hover:bg-accent transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
          </button>
        ) : (
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted shrink-0">
            <FileIcon className="size-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <p className="font-medium truncate">{file.name}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {file.sizeBytes && <span>{formatFileSize(file.sizeBytes)}</span>}
            {isSuperseded && (
              <>
                <span>&middot;</span>
                <span className="text-amber-600 dark:text-amber-400">
                  Superseded
                </span>
              </>
            )}
            {hasVersions && file.previousVersions && (
              <>
                <span>&middot;</span>
                <span>
                  {file.previousVersions.length} previous version
                  {file.previousVersions.length !== 1 ? "s" : ""}
                </span>
              </>
            )}
            {file.tags && file.tags.length > 0 && (
              <>
                <span>&middot;</span>
                <span className="flex items-center gap-1">
                  <Tag className="size-3" />
                  {file.tags.join(", ")}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="squircle shrink-0"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="squircle">
          <DropdownMenuItem onClick={onView}>
            <Eye className="size-4" />
            View
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDownload}>
            <Download className="size-4" />
            Download
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Upload Dialog ──────────────────────────────────────────────────────────

function UploadDialog({
  open,
  onOpenChange,
  orgId,
  projectId,
  existingTags,
  existingFiles,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  projectId: string;
  existingTags: string[];
  existingFiles: UnifiedFile[];
  onSuccess: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, number>
  >({});
  // Superseding detection: maps file name → replacement info
  const [replacesMap, setReplacesMap] = useState<
    Record<string, string | null>
  >({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedFiles([]);
      setTags([]);
      setTagInput("");
      setUploadProgress({});
      setReplacesMap({});
    }
  }, [open]);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
    }
  }

  function addFiles(newFiles: File[]) {
    const maxSize = 100 * 1024 * 1024;
    const validFiles = newFiles.filter((f) => f.size <= maxSize);
    const oversizedCount = newFiles.length - validFiles.length;

    if (oversizedCount > 0) {
      toast.error(`${oversizedCount} file(s) exceed 100MB limit`);
    }

    // Check for name collisions
    for (const file of validFiles) {
      const match = existingFiles.find(
        (ef) => ef.name.toLowerCase() === file.name.toLowerCase()
      );
      if (match) {
        // Default to null (different file). User can choose to replace.
        setReplacesMap((prev) => ({
          ...prev,
          [file.name]: null,
        }));
      }
    }

    setSelectedFiles((prev) => [...prev, ...validFiles]);
  }

  function removeFile(index: number) {
    const file = selectedFiles[index];
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setReplacesMap((prev) => {
      const next = { ...prev };
      delete next[file.name];
      return next;
    });
  }

  function setReplaces(fileName: string, sourceId: string | null) {
    setReplacesMap((prev) => ({ ...prev, [fileName]: sourceId }));
  }

  function addTag(tag: string) {
    const normalizedTag = tag.trim().toLowerCase();
    if (normalizedTag && !tags.includes(normalizedTag)) {
      setTags((prev) => [...prev, normalizedTag]);
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return;

    setIsUploading(true);

    try {
      for (const file of selectedFiles) {
        const replacesId = replacesMap[file.name] || undefined;

        const createResponse = await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/files`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              sizeBytes: file.size,
              mimeType: file.type || "application/octet-stream",
              tags,
              ...(replacesId ? { replacesId } : {}),
            }),
          }
        );

        if (!createResponse.ok) {
          const data = await createResponse.json();
          throw new Error(
            data.error || `Failed to create file record for ${file.name}`
          );
        }

        const { uploadUrl } = await createResponse.json();

        setUploadProgress((prev) => ({ ...prev, [file.name]: 0 }));

        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
        });

        if (!uploadResponse.ok) {
          throw new Error(`Failed to upload ${file.name}`);
        }

        setUploadProgress((prev) => ({ ...prev, [file.name]: 100 }));
      }

      toast.success(`${selectedFiles.length} file(s) uploaded`);
      onSuccess();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Upload failed"
      );
    } finally {
      setIsUploading(false);
    }
  }

  // Find the existing file that has the same name
  function findExistingByName(name: string) {
    return existingFiles.find(
      (ef) => ef.name.toLowerCase() === name.toLowerCase()
    );
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent className="squircle">
        <BottomSheetHeader>
          <BottomSheetTitle>Upload Files</BottomSheetTitle>
          <BottomSheetDescription>
            Upload files to this project (max 100MB each)
          </BottomSheetDescription>
        </BottomSheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="space-y-4 py-4">
          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
              isDragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            )}
          >
            <Upload className="size-8 mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Drag and drop files here, or click to browse
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* Selected files */}
          {selectedFiles.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {selectedFiles.length} file(s) selected
              </p>
              <div className="max-h-60 overflow-y-auto space-y-2">
                {selectedFiles.map((file, index) => {
                  const existing = findExistingByName(file.name);
                  const hasCollision = !!existing;
                  const isReplacing =
                    hasCollision && replacesMap[file.name] !== null;

                  return (
                    <div key={`${file.name}-${index}`}>
                      <div className="flex items-center justify-between gap-2 p-2 rounded border bg-muted/50">
                        <div className="flex items-center gap-2 min-w-0">
                          <File className="size-4 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate">
                            {file.name}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            ({formatFileSize(file.size)})
                          </span>
                        </div>
                        {uploadProgress[file.name] !== undefined ? (
                          <span className="text-xs text-muted-foreground">
                            {uploadProgress[file.name]}%
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeFile(index)}
                            className="size-6"
                            disabled={isUploading}
                          >
                            <X className="size-3" />
                          </Button>
                        )}
                      </div>

                      {/* Name collision prompt */}
                      {hasCollision &&
                        uploadProgress[file.name] === undefined && (
                          <div className="ml-6 mt-1 p-2 rounded border border-amber-200 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/30">
                            <p className="text-xs text-amber-800 dark:text-amber-200 mb-1.5">
                              A file named &ldquo;{file.name}&rdquo; already
                              exists. Does this replace the existing file?
                            </p>
                            <div className="flex gap-2">
                              <Button
                                variant={isReplacing ? "default" : "outline"}
                                size="sm"
                                className="h-6 text-xs squircle"
                                onClick={() =>
                                  setReplaces(
                                    file.name,
                                    existing!.sourceId
                                  )
                                }
                                disabled={isUploading}
                              >
                                Yes, replace it
                              </Button>
                              <Button
                                variant={!isReplacing ? "default" : "outline"}
                                size="sm"
                                className="h-6 text-xs squircle"
                                onClick={() =>
                                  setReplaces(file.name, null)
                                }
                                disabled={isUploading}
                              >
                                No, keep both
                              </Button>
                            </div>
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tags */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Tags (optional)</p>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="squircle">
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="ml-1 hover:text-destructive"
                    disabled={isUploading}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
                placeholder="Add a tag..."
                className="squircle"
                disabled={isUploading}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => tagInput.trim() && addTag(tagInput)}
                disabled={!tagInput.trim() || isUploading}
                className="squircle"
              >
                <Plus className="size-4" />
              </Button>
            </div>
            {existingTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="text-xs text-muted-foreground">
                  Existing:
                </span>
                {existingTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => addTag(tag)}
                    className="text-xs text-primary hover:underline"
                    disabled={tags.includes(tag) || isUploading}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        </div>

        <BottomSheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isUploading}
            className="squircle"
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={selectedFiles.length === 0 || isUploading}
            className="squircle"
          >
            {isUploading && <Loader2 className="size-4 animate-spin" />}
            Upload{" "}
            {selectedFiles.length > 0 && `(${selectedFiles.length})`}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}
