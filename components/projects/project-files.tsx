"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Download,
  Eye,
  File,
  FileText,
  Image,
  Loader2,
  MoreVertical,
  Plus,
  Tag,
  Trash2,
  Upload,
  X,
  FileArchive,
  FileSpreadsheet,
  FileCode,
  Video,
  Music,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ProjectFile = {
  id: string;
  projectId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  tags: string[];
  isPublic: boolean;
  createdAt: string;
  uploadedByUser?: {
    id: string;
    name: string | null;
    email: string;
  };
};

type ProjectFilesProps = {
  orgId: string;
  projectId: string;
};

// File type icon mapping
function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("video/")) return Video;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("pdf")) return FileText;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return FileSpreadsheet;
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("compressed")) return FileArchive;
  if (mimeType.includes("json") || mimeType.includes("javascript") || mimeType.includes("html") || mimeType.includes("css")) return FileCode;
  return File;
}

// Format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ProjectFiles({ orgId, projectId }: ProjectFilesProps) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<ProjectFile | null>(null);

  const fetchFiles = useCallback(async () => {
    try {
      const params = selectedTag ? `?tag=${encodeURIComponent(selectedTag)}` : "";
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files${params}`
      );
      if (response.ok) {
        const data = await response.json();
        setFiles(data.files);
        setAllTags(data.tags);
      }
    } catch (err) {
      console.error("Error fetching files:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, selectedTag]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  async function handleDownload(file: ProjectFile) {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/${file.id}?action=download`
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

  async function handleView(file: ProjectFile) {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/${file.id}?action=view`
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
    if (!fileToDelete) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/${fileToDelete.id}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        toast.success("File deleted");
        fetchFiles();
      } else {
        toast.error("Failed to delete file");
      }
    } catch {
      toast.error("Failed to delete file");
    } finally {
      setDeleteDialogOpen(false);
      setFileToDelete(null);
    }
  }

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <File className="size-5" />
            Files
          </CardTitle>
          <CardDescription>
            Project documents and attachments
          </CardDescription>
        </div>
        <Button
          onClick={() => setUploadDialogOpen(true)}
          size="sm"
          className="squircle"
        >
          <Upload className="size-4" />
          Upload
        </Button>
      </CardHeader>
      <CardContent>
        {/* Tag filter */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            <Badge
              variant={selectedTag === null ? "default" : "outline"}
              className="squircle cursor-pointer"
              onClick={() => setSelectedTag(null)}
            >
              All
            </Badge>
            {allTags.map((tag) => (
              <Badge
                key={tag}
                variant={selectedTag === tag ? "default" : "outline"}
                className="squircle cursor-pointer"
                onClick={() => setSelectedTag(tag)}
              >
                <Tag className="size-3 mr-1" />
                {tag}
              </Badge>
            ))}
          </div>
        )}

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
              {selectedTag ? `No files with tag "${selectedTag}"` : "No files uploaded yet"}
            </p>
            {!selectedTag && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUploadDialogOpen(true)}
                className="mt-4 squircle"
              >
                <Upload className="size-4" />
                Upload your first file
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                onDownload={() => handleDownload(file)}
                onView={() => handleView(file)}
                onDelete={() => {
                  setFileToDelete(file);
                  setDeleteDialogOpen(true);
                }}
              />
            ))}
          </div>
        )}
      </CardContent>

      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        orgId={orgId}
        projectId={projectId}
        existingTags={allTags}
        onSuccess={fetchFiles}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{fileToDelete?.name}&rdquo;. This action
              cannot be undone.
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
    </Card>
  );
}

function FileRow({
  file,
  onDownload,
  onView,
  onDelete,
}: {
  file: ProjectFile;
  onDownload: () => void;
  onView: () => void;
  onDelete: () => void;
}) {
  const FileIcon = getFileIcon(file.mimeType);

  return (
    <div className="flex items-center justify-between gap-4 p-3 rounded-lg border hover:bg-accent/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted shrink-0">
          <FileIcon className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{file.name}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatFileSize(file.sizeBytes)}</span>
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
          <Button variant="ghost" size="icon" className="squircle shrink-0">
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
          <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  orgId,
  projectId,
  existingTags,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  projectId: string;
  existingTags: string[];
  onSuccess: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedFiles([]);
      setTags([]);
      setTagInput("");
      setUploadProgress({});
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

    const droppedFiles = Array.from(e.dataTransfer.files);
    addFiles(droppedFiles);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      addFiles(selected);
    }
  }

  function addFiles(newFiles: File[]) {
    // Filter out files over 100MB
    const maxSize = 100 * 1024 * 1024;
    const validFiles = newFiles.filter((f) => f.size <= maxSize);
    const oversizedCount = newFiles.length - validFiles.length;

    if (oversizedCount > 0) {
      toast.error(`${oversizedCount} file(s) exceed 100MB limit`);
    }

    setSelectedFiles((prev) => [...prev, ...validFiles]);
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
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
        // Step 1: Create file record and get upload URL
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
            }),
          }
        );

        if (!createResponse.ok) {
          const data = await createResponse.json();
          throw new Error(data.error || `Failed to create file record for ${file.name}`);
        }

        const { uploadUrl } = await createResponse.json();

        // Step 2: Upload file directly to R2
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
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
          <DialogDescription>
            Upload files to this project (max 100MB each)
          </DialogDescription>
        </DialogHeader>

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
              <div className="max-h-40 overflow-y-auto space-y-2">
                {selectedFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between gap-2 p-2 rounded border bg-muted/50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <File className="size-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">{file.name}</span>
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
                ))}
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
                <span className="text-xs text-muted-foreground">Existing:</span>
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

        <DialogFooter>
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
            Upload {selectedFiles.length > 0 && `(${selectedFiles.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
