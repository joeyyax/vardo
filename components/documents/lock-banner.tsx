"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lock, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type LockBannerProps = {
  userName: string;
  lastActiveAt: string;
  onRequestEdit: () => Promise<void>;
  requested: boolean;
  transferred: boolean;
};

export function LockBanner({
  userName,
  lastActiveAt,
  onRequestEdit,
  requested,
  transferred,
}: LockBannerProps) {
  const [requesting, setRequesting] = useState(false);

  if (transferred) return null;

  const lastActive = formatDistanceToNow(new Date(lastActiveAt), {
    addSuffix: true,
  });

  async function handleRequest() {
    setRequesting(true);
    try {
      await onRequestEdit();
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-sm">
      <Lock className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
      <span className="text-amber-800 dark:text-amber-200">
        <strong>{userName}</strong> is editing
        <span className="text-amber-600 dark:text-amber-400 ml-1">
          &middot; Last active {lastActive}
        </span>
      </span>

      <div className="ml-auto">
        {requested ? (
          <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            Waiting for {userName} to respond...
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50"
            onClick={handleRequest}
            disabled={requesting}
          >
            {requesting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              "Request Edit"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
