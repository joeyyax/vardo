"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Inbox,
  Loader2,
  Search,
  X,
  Mail,
  Paperclip,
  FileText,
  Image,
  CheckCircle2,
  Info,
  Trash2,
  Building2,
  FolderKanban,
} from "lucide-react";
import { format } from "date-fns";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";
import { PageToolbar } from "@/components/page-toolbar";
import { InboxItemDetail } from "./inbox-item-detail";
import { cn } from "@/lib/utils";
import type { InboxItem } from "./types";

type InboxContentProps = {
  orgId: string;
};

export function InboxContent({ orgId }: InboxContentProps) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("needs_review");
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== "all") {
        params.set("status", statusFilter);
      }
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox?${params}`
      );
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setItems(data.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [orgId, statusFilter]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // Filter by search term (client-side)
  const filteredItems = items.filter((item) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      item.subject?.toLowerCase().includes(q) ||
      item.fromAddress?.toLowerCase().includes(q) ||
      item.fromName?.toLowerCase().includes(q)
    );
  });

  const hasActiveFilters = search || statusFilter !== "needs_review";

  function clearFilters() {
    setSearch("");
    setStatusFilter("needs_review");
  }

  function handleRowClick(item: InboxItem) {
    setSelectedItem(item);
    setDetailOpen(true);
  }

  function handleDetailClose() {
    setDetailOpen(false);
    setSelectedItem(null);
  }

  function handleItemUpdated() {
    fetchItems();
  }

  return (
    <>
      <PageToolbar>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by sender or subject..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 w-[260px]"
          />
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="needs_review">Needs review</SelectItem>
            <SelectItem value="converted">Converted</SelectItem>
            <SelectItem value="informational">Informational</SelectItem>
            <SelectItem value="discarded">Discarded</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 size-3" />
            Clear
          </Button>
        )}
      </PageToolbar>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Inbox className="size-10 mb-3" />
          <p className="text-sm font-medium">
            {items.length === 0
              ? "No inbox items yet"
              : "No items match your filters"}
          </p>
          <p className="text-xs mt-1">
            {items.length === 0
              ? "Forward emails to your intake address to get started."
              : "Try adjusting your search or filters."}
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">From</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="w-[140px]">Associated With</TableHead>
              <TableHead className="w-[100px]">Files</TableHead>
              <TableHead className="w-[120px]">Received</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItems.map((item) => (
              <TableRow
                key={item.id}
                className="cursor-pointer"
                onClick={() => handleRowClick(item)}
              >
                <TableCell>
                  <div className="flex items-center gap-2 min-w-0">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {item.fromName || item.fromAddress || "Unknown"}
                      </div>
                      {item.fromName && item.fromAddress && (
                        <div className="truncate text-xs text-muted-foreground">
                          {item.fromAddress}
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-sm">{item.subject || "(no subject)"}</span>
                </TableCell>
                <TableCell>
                  <EntityBadge item={item} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Paperclip className="size-3.5" />
                    <span className="text-sm">{item.files?.length || 0}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">
                    {format(new Date(item.receivedAt), "MMM d, yyyy")}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selectedItem && (
        <InboxItemDetail
          orgId={orgId}
          item={selectedItem}
          open={detailOpen}
          onOpenChange={(open) => {
            if (!open) handleDetailClose();
          }}
          onItemUpdated={handleItemUpdated}
        />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "needs_review":
      return (
        <Badge variant="secondary" className="gap-1">
          <Mail className="size-3" />
          Needs review
        </Badge>
      );
    case "converted":
      return (
        <Badge variant="default" className="gap-1 bg-green-600 hover:bg-green-700">
          <CheckCircle2 className="size-3" />
          Converted
        </Badge>
      );
    case "informational":
      return (
        <Badge variant="outline" className="gap-1">
          <Info className="size-3" />
          Informational
        </Badge>
      );
    case "discarded":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Trash2 className="size-3" />
          Discarded
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function EntityBadge({ item }: { item: InboxItem }) {
  if (item.project) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground truncate">
        <FolderKanban className="size-3.5 shrink-0" />
        <span className="truncate">{item.project.name}</span>
      </div>
    );
  }
  if (item.client) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground truncate">
        <Building2 className="size-3.5 shrink-0" />
        <span className="truncate">{item.client.name}</span>
      </div>
    );
  }
  return <span className="text-xs text-muted-foreground">General</span>;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === "application/pdf") {
    return <FileText className="size-4 text-red-500" />;
  }
  if (mimeType.startsWith("image/")) {
    return <Image className="size-4 text-blue-500" />;
  }
  return <Paperclip className="size-4 text-muted-foreground" />;
}
