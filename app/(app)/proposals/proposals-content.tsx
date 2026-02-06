"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow, format } from "date-fns";
import { Button } from "@/components/ui/button";
import { ListRow, ListContainer } from "@/components/ui/list-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CheckCircle2,
  Copy,
  Eye,
  FileText,
  Loader2,
  MoreVertical,
  Plus,
  Send,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { NewDocumentDialog } from "@/components/documents/new-document-dialog";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewPreference } from "@/hooks/use-view-preference";
import { PageToolbar } from "@/components/page-toolbar";

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
  project: {
    id: string;
    name: string;
    client: {
      id: string;
      name: string;
      color: string | null;
    };
  };
  createdByUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
};

type ProposalsContentProps = {
  orgId: string;
};

const STATUS_CONFIG = {
  draft: {
    icon: FileText,
    label: "Draft",
    color: "text-muted-foreground bg-muted",
  },
  sent: {
    icon: Send,
    label: "Sent",
    color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900",
  },
  viewed: {
    icon: Eye,
    label: "Viewed",
    color: "text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900",
  },
  accepted: {
    icon: CheckCircle2,
    label: "Accepted",
    color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900",
  },
  declined: {
    icon: XCircle,
    label: "Declined",
    color: "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900",
  },
};

const PROPOSAL_VIEWS = ["list", "table"] as const;

export function ProposalsContent({ orgId }: ProposalsContentProps) {
  const router = useRouter();
  const [view, setView] = useViewPreference("proposals", PROPOSAL_VIEWS, "list");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [summary, setSummary] = useState<{
    total: number;
    byStatus: Record<string, number>;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchDocuments = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ type: "proposal" });
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }

      const response = await fetch(
        `/api/v1/organizations/${orgId}/documents?${params}`
      );
      if (response.ok) {
        const data = await response.json();
        setDocuments(data.documents);
        setSummary(data.summary);
      }
    } catch (err) {
      console.error("Error fetching proposals:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, statusFilter]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  async function copyPublicLink(doc: Document) {
    if (!doc.publicToken) return;
    const url = `${window.location.origin}/d/${doc.publicToken}`;
    await navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  }

  // Filter to only proposals
  const proposals = documents.filter((d) => d.type === "proposal");

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <>
            {summary && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {proposals.length} proposals
                </span>
                {summary.byStatus?.accepted && (
                  <span className="text-green-600 dark:text-green-400">
                    {summary.byStatus.accepted} accepted
                  </span>
                )}
                {summary.byStatus?.sent && (
                  <span className="text-blue-600 dark:text-blue-400">
                    {summary.byStatus.sent} pending
                  </span>
                )}
              </div>
            )}
            <ViewSwitcher views={PROPOSAL_VIEWS} value={view} onValueChange={setView} />
            <Button onClick={() => setDialogOpen(true)} className="squircle">
              <Plus className="size-4" />
              New Proposal
            </Button>
          </>
        }
      >
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px] squircle">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent className="squircle">
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="viewed">Viewed</SelectItem>
            <SelectItem value="accepted">Accepted</SelectItem>
            <SelectItem value="declined">Declined</SelectItem>
          </SelectContent>
        </Select>
      </PageToolbar>

      {/* Proposals */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : proposals.length === 0 ? (
        <div className="py-12 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
            <FileText className="size-6 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-lg font-medium">No proposals yet</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Create proposals to send to clients.
          </p>
          <Button onClick={() => setDialogOpen(true)} className="mt-4 squircle">
            <Plus className="size-4" />
            New Proposal
          </Button>
        </div>
      ) : view === "table" ? (
        <div className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposals.map((doc) => {
                const config = STATUS_CONFIG[doc.status];
                const StatusIcon = config.icon;

                return (
                  <TableRow
                    key={doc.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/projects/${doc.project.id}/documents/${doc.id}`)}
                  >
                    <TableCell className="font-medium">{doc.title}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div
                          className="size-2 rounded-full shrink-0"
                          style={{ backgroundColor: doc.project.client.color || "#94a3b8" }}
                        />
                        {doc.project.client.name}
                      </div>
                    </TableCell>
                    <TableCell>{doc.project.name}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs",
                          config.color
                        )}
                      >
                        <StatusIcon className="size-3" />
                        {config.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {doc.sentAt
                        ? `Sent ${formatDistanceToNow(new Date(doc.sentAt), { addSuffix: true })}`
                        : format(new Date(doc.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>
                      <ProposalActions doc={doc} onCopyLink={copyPublicLink} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <ListContainer>
          {proposals.map((doc, index) => {
            const isLast = index === proposals.length - 1;
            const config = STATUS_CONFIG[doc.status];
            const StatusIcon = config.icon;

            return (
              <ListRow
                key={doc.id}
                onClick={() => router.push(`/projects/${doc.project.id}/documents/${doc.id}`)}
                isLast={isLast}
              >
                {/* Left: Color indicator */}
                <div
                  className="size-3 rounded-full shrink-0"
                  style={{ backgroundColor: doc.project.client.color || "#94a3b8" }}
                />

                {/* Middle: Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{doc.title}</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs",
                        config.color
                      )}
                    >
                      <StatusIcon className="size-3" />
                      {config.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-0.5">
                    <span>{doc.project.client.name}</span>
                    <span className="text-muted-foreground/50">&middot;</span>
                    <span>{doc.project.name}</span>
                    {doc.sentAt && (
                      <>
                        <span className="text-muted-foreground/50">&middot;</span>
                        <span>
                          Sent {formatDistanceToNow(new Date(doc.sentAt), { addSuffix: true })}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Right: Actions with hover visibility */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="size-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="squircle">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/projects/${doc.project.id}/documents/${doc.id}`);
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
                  </DropdownMenuContent>
                </DropdownMenu>
              </ListRow>
            );
          })}
        </ListContainer>
      )}

      <NewDocumentDialog
        orgId={orgId}
        type="proposal"
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

function ProposalActions({
  doc,
  onCopyLink,
}: {
  doc: Document;
  onCopyLink: (doc: Document) => void;
}) {
  const router = useRouter();

  return (
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
            router.push(`/projects/${doc.project.id}/documents/${doc.id}`);
          }}
        >
          <Eye className="size-4" />
          {doc.status === "draft" ? "Edit" : "View"}
        </DropdownMenuItem>
        {doc.publicToken && doc.status !== "draft" && (
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onCopyLink(doc);
            }}
          >
            <Copy className="size-4" />
            Copy Link
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
