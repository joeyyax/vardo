"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/relative-time";
import { toast } from "@/lib/messenger";
import { BAN_REASON_LABEL } from "@/lib/probe-guard/summary";

export type BanItem = {
  id: string;
  ip: string;
  reason: string;
  hits: number;
  originName: string | null;
  createdAt: string;
  expiresAt: string;
  appName?: string | null;
};

/** Active bans with one-click unban. `unbanUrl` maps a ban id to its DELETE endpoint. */
export function BansList({
  bans,
  unbanUrl,
  onChange,
  canUnban = true,
}: {
  bans: BanItem[];
  unbanUrl: (id: string) => string;
  onChange: () => void;
  canUnban?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);

  async function unban(ban: BanItem) {
    setPending(ban.id);
    try {
      const res = await fetch(unbanUrl(ban.id), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Couldn't lift the ban");
        return;
      }
      toast.success(`Unbanned ${ban.ip}`);
      onChange();
    } catch {
      toast.error("Couldn't lift the ban");
    } finally {
      setPending(null);
    }
  }

  if (bans.length === 0) return <p className="text-xs text-muted-foreground">No active bans.</p>;

  return (
    <ul className="divide-y rounded-lg border">
      {bans.map((ban) => (
        <li key={ban.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
          <div className="min-w-0 space-y-0.5">
            <p className="font-mono text-sm">{ban.ip}</p>
            <p className="text-xs text-muted-foreground">
              {ban.reason === "mesh" && ban.originName ? `Shared by ${ban.originName}` : BAN_REASON_LABEL[ban.reason] ?? ban.reason}
              {ban.appName ? ` on ${ban.appName}` : ""}
              {" · ends "}
              <RelativeTime date={ban.expiresAt} />
            </p>
          </div>
          {canUnban && (
            <Button size="sm" variant="outline" onClick={() => void unban(ban)} disabled={pending === ban.id}>
              {pending === ban.id ? <Loader2 className="size-4 animate-spin" /> : "Unban"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
