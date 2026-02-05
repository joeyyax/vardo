"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow, format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  FileCheck,
  FileText,
  Loader2,
  MoreVertical,
  Plus,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Document = {
  id: string;
  type: "proposal" | "contract";
  status: "draft" | "sent" | "viewed" | "accepted" | "declined";
  title: string;
  publicToken: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  createdAt: string;
  createdByUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
};

type ProjectDocumentsProps = {
  orgId: string;
  projectId: string;
};

const STATUS_CONFIG = {
  draft: {
    icon: FileText,
    label: "Draft",
    color: "text-muted-foreground",
  },
  sent: {
    icon: Send,
    label: "Sent",
    color: "text-blue-600 dark:text-blue-400",
  },
  viewed: {
    icon: Eye,
    label: "Viewed",
    color: "text-amber-600 dark:text-amber-400",
  },
  accepted: {
    icon: CheckCircle2,
    label: "Accepted",
    color: "text-green-600 dark:text-green-400",
  },
  declined: {
    icon: XCircle,
    label: "Declined",
    color: "text-red-600 dark:text-red-400",
  },
};

export function ProjectDocuments({ orgId, projectId }: ProjectDocumentsProps) {
  const router = useRouter();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDocument, setDeleteDocument] = useState<Document | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newDocType, setNewDocType] = useState<"proposal" | "contract">("proposal");
  const [newDocTitle, setNewDocTitle] = useState("");

  const fetchDocuments = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents`
      );
      if (response.ok) {
        const data = await response.json();
        setDocuments(data);
      }
    } catch (err) {
      console.error("Error fetching documents:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  async function handleCreate() {
    if (!newDocTitle.trim()) {
      toast.error("Title is required");
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: newDocType,
            title: newDocTitle.trim(),
          }),
        }
      );

      if (response.ok) {
        const document = await response.json();
        setCreateDialogOpen(false);
        setNewDocTitle("");
        setNewDocType("proposal");
        toast.success(`${newDocType === "proposal" ? "Proposal" : "Contract"} created`);
        // Navigate to edit the document
        router.push(`/projects/${projectId}/documents/${document.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to create document");
      }
    } catch {
      toast.error("Failed to create document");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteDocument) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${deleteDocument.id}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        fetchDocuments();
        toast.success("Document deleted");
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to delete document");
      }
    } catch {
      toast.error("Failed to delete document");
    } finally {
      setDeleteDocument(null);
    }
  }

  async function copyPublicLink(document: Document) {
    if (!document.publicToken) return;
    const url = `${window.location.origin}/d/${document.publicToken}`;
    await navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  }

  return (
    <Card className="squircle">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileCheck className="size-5" />
              Documents
            </CardTitle>
            <CardDescription>Proposals and contracts</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => setCreateDialogOpen(true)}
            className="squircle"
          >
            <Plus className="size-4" />
            New
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : documents.length === 0 ? (
          <div className="text-center py-8">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <FileText className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              No documents yet
            </p>
            <Button
              variant="link"
              size="sm"
              onClick={() => setCreateDialogOpen(true)}
              className="mt-2"
            >
              Create your first proposal
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => {
              const config = STATUS_CONFIG[doc.status];
              const StatusIcon = config.icon;

              return (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors cursor-pointer"
                  onClick={() => router.push(`/projects/${projectId}/documents/${doc.id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full shrink-0",
                        doc.type === "proposal" ? "bg-blue-100 dark:bg-blue-900" : "bg-purple-100 dark:bg-purple-900"
                      )}
                    >
                      <FileText
                        className={cn(
                          "size-4",
                          doc.type === "proposal" ? "text-blue-600 dark:text-blue-400" : "text-purple-600 dark:text-purple-400"
                        )}
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{doc.title}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="capitalize">{doc.type}</span>
                        <span>&middot;</span>
                        <StatusIcon className={cn("size-3", config.color)} />
                        <span className={config.color}>{config.label}</span>
                        {doc.status !== "draft" && doc.sentAt && (
                          <>
                            <span>&middot;</span>
                            <span>
                              Sent {formatDistanceToNow(new Date(doc.sentAt), { addSuffix: true })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="size-8 shrink-0">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="squircle">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/projects/${projectId}/documents/${doc.id}`);
                        }}
                      >
                        <Eye className="size-4" />
                        {doc.status === "draft" ? "Edit" : "View"}
                      </DropdownMenuItem>
                      {doc.publicToken && doc.status !== "draft" && (
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            copyPublicLink(doc);
                          }}
                        >
                          <Copy className="size-4" />
                          Copy Link
                        </DropdownMenuItem>
                      )}
                      {doc.status === "draft" && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteDocument(doc);
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
            })}
          </div>
        )}
      </CardContent>

      {/* Create Document Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="squircle">
          <DialogHeader>
            <DialogTitle>Create Document</DialogTitle>
            <DialogDescription>
              Create a new proposal or contract for this project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="doc-type">Type</Label>
              <Select value={newDocType} onValueChange={(v) => setNewDocType(v as "proposal" | "contract")}>
                <SelectTrigger id="doc-type" className="squircle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="proposal">Proposal</SelectItem>
                  <SelectItem value="contract">Contract</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="doc-title">Title</Label>
              <Input
                id="doc-title"
                value={newDocTitle}
                onChange={(e) => setNewDocTitle(e.target.value)}
                placeholder={newDocType === "proposal" ? "Project Proposal" : "Service Agreement"}
                className="squircle"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={isCreating || !newDocTitle.trim()}
              className="squircle"
            >
              {isCreating && <Loader2 className="size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Document Dialog */}
      <AlertDialog open={!!deleteDocument} onOpenChange={() => setDeleteDocument(null)}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteDocument?.title}&rdquo;. This action cannot be undone.
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
