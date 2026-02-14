"use client";

import { useEffect, useState } from "react";
import { Inbox, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import type { InboxItem } from "./types";

type EntityInboxSectionProps = {
  orgId: string;
  entityType: "project" | "client";
  entityId: string;
};

export function EntityInboxSection({
  orgId,
  entityType,
  entityId,
}: EntityInboxSectionProps) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    async function fetchItems() {
      try {
        const param = entityType === "project" ? "projectId" : "clientId";
        const res = await fetch(
          `/api/v1/organizations/${orgId}/inbox?${param}=${entityId}&status=needs_review&limit=5`
        );
        if (res.ok) {
          const data = await res.json();
          setItems(data.items);
          setCount(data.needsReviewCount);
          // Auto-open if there are items needing review
          if (data.needsReviewCount > 0) {
            setOpen(true);
          }
        }
      } catch {
        // Non-blocking — inbox failure shouldn't break the dashboard
      } finally {
        setLoading(false);
      }
    }
    fetchItems();
  }, [orgId, entityType, entityId]);

  if (loading) return null;
  if (count === 0 && items.length === 0) return null;

  const filterParam = entityType === "project" ? "projectId" : "clientId";
  const viewAllHref = `/inbox?${filterParam}=${entityId}`;

  return (
    <Card className="squircle">
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <Inbox className="size-5" />
            Inbox
            {count > 0 && (
              <Badge variant="secondary" className="ml-1">
                {count}
              </Badge>
            )}
          </CardTitle>
          <Link
            href={viewAllHref}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            View all
            <ExternalLink className="size-3" />
          </Link>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-0">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No items need review.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <Link
                  key={item.id}
                  href={`/inbox?item=${item.id}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium truncate">
                      {item.subject || "(no subject)"}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {item.fromName || item.fromAddress || "Unknown sender"}
                      {entityType === "client" && item.project && (
                        <> &middot; {item.project.name}</>
                      )}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-3">
                    {formatDistanceToNow(new Date(item.receivedAt), {
                      addSuffix: true,
                    })}
                  </span>
                </Link>
              ))}
              {count > items.length && (
                <Link
                  href={viewAllHref}
                  className="block text-center text-xs text-muted-foreground hover:text-foreground py-1"
                >
                  +{count - items.length} more
                </Link>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
