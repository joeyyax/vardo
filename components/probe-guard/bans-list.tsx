"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { RelativeTime } from "@/components/relative-time";
import { toast } from "@/lib/messenger";
import { banReasonLine, type BanDetail } from "@/lib/probe-guard/summary";
import { isPermanent } from "@/lib/probe-guard/permanent";

export type BanItem = {
  id: string;
  ip: string;
  reason: string;
  hits: number;
  originName: string | null;
  createdAt: string;
  expiresAt: string;
  appName?: string | null;
  detail?: BanDetail | null;
};

/** Active bans with unban and, for admins, ban permanently. `banUrl` maps a ban id to its endpoint. */
export function BansList({
  bans,
  banUrl,
  onChange,
  canUnban = true,
  canBanPermanently = false,
}: {
  bans: BanItem[];
  banUrl: (id: string) => string;
  onChange: () => void;
  canUnban?: boolean;
  canBanPermanently?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);

  async function send(ban: BanItem, init: RequestInit, done: string, failed: string) {
    setPending(ban.id);
    try {
      const res = await fetch(banUrl(ban.id), init);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? failed);
        return;
      }
      toast.success(done);
      onChange();
    } catch {
      toast.error(failed);
    } finally {
      setPending(null);
    }
  }

  const unban = (ban: BanItem) => send(ban, { method: "DELETE" }, `Unbanned ${ban.ip}`, "Couldn't lift the ban");
  const banPermanently = (ban: BanItem) =>
    send(
      ban,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permanent: true }) },
      `Banned ${ban.ip} permanently`,
      "Couldn't make the ban permanent",
    );

  if (bans.length === 0) return <p className="text-xs text-muted-foreground">No active bans.</p>;

  return (
    <ul className="divide-y rounded-lg border">
      {bans.map((ban) => {
        const permanent = isPermanent(ban.expiresAt);
        const busy = pending === ban.id;
        return (
          <li key={ban.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-mono text-sm">{ban.ip}</p>
              <BanReason ban={ban} permanent={permanent} />
            </div>
            {(canUnban || (canBanPermanently && !permanent)) && (
              <div className="flex shrink-0 items-center gap-2">
                {canBanPermanently && !permanent && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" disabled={busy}>
                        Ban permanently
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Ban {ban.ip} permanently?</AlertDialogTitle>
                        <AlertDialogDescription>
                          It stays banned until someone unbans it.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void banPermanently(ban)}>Ban permanently</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                {canUnban && (
                  <Button size="sm" variant="outline" onClick={() => void unban(ban)} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : "Unban"}
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Why the address is banned and until when. Expands to the paths it probed. */
function BanReason({ ban, permanent }: { ban: BanItem; permanent: boolean }) {
  const [open, setOpen] = useState(false);
  const paths = ban.detail?.paths ?? [];
  const reason = banReasonLine(ban);
  const until = permanent ? (
    <span className="font-medium text-foreground">Permanent</span>
  ) : (
    <>
      ends <RelativeTime date={ban.expiresAt} />
    </>
  );

  if (paths.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {reason} · {until}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-left transition-colors hover:text-foreground"
        >
          <DisclosureChevron open={open} className="text-current" />
          {reason}
        </button>
        {" · "}
        {until}
      </p>
      {open && (
        <ul className="ml-4.5 space-y-0.5 text-xs text-muted-foreground">
          {paths.map((p) => (
            <li key={p.path} className="flex gap-2">
              <span className="min-w-0 truncate font-mono">{p.path}</span>
              <span className="shrink-0 tabular-nums">×{p.count.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
