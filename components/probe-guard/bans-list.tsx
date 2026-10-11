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
import { reporterLink } from "@/lib/probe-guard/reporting/links";
import type { BanStatus } from "@/lib/probe-guard/history-view";

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
  /** The reporter that took a report on this address. */
  reportedTo?: string | null;
  /** Requests turned away under this ban. */
  blockedCount?: number;
  lastBlockedAt?: string | null;
  /** Set for bans that may have ended; missing means active. */
  status?: BanStatus;
};

export const ALLOWED_FROM_BAN_NOTE = "Allowed from a ban";

/**
 * Bans with unban and, for admins, ban permanently and allow. Ended bans offer ban again and allow.
 * `banUrl` maps a ban id to its endpoint; `allowUrl` is the allowlist endpoint.
 */
export function BansList({
  bans,
  banUrl,
  onChange,
  canUnban = true,
  canBanPermanently = false,
  allowUrl,
  canBanAgain = false,
  showCreated = false,
  emptyText = "No active bans.",
}: {
  bans: BanItem[];
  banUrl: (id: string) => string;
  onChange: () => void;
  canUnban?: boolean;
  canBanPermanently?: boolean;
  allowUrl?: string;
  canBanAgain?: boolean;
  showCreated?: boolean;
  emptyText?: string;
}) {
  const [pending, setPending] = useState<string | null>(null);

  async function send(ban: BanItem, init: RequestInit, done: string, failed: string, url = banUrl(ban.id)) {
    setPending(ban.id);
    try {
      const res = await fetch(url, init);
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
  const allow = (ban: BanItem) =>
    allowUrl
      ? send(
          ban,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: ban.ip, note: ALLOWED_FROM_BAN_NOTE }) },
          `Allowed ${ban.ip}`,
          "Couldn't allow the address",
          allowUrl,
        )
      : Promise.resolve();
  const banAgain = (ban: BanItem) =>
    send(
      ban,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ again: true }) },
      `Banned ${ban.ip} again`,
      "Couldn't ban the address",
    );

  if (bans.length === 0) return <p className="text-xs text-muted-foreground">{emptyText}</p>;

  return (
    <ul className="divide-y rounded-lg border">
      {bans.map((ban) => {
        const permanent = isPermanent(ban.expiresAt);
        const busy = pending === ban.id;
        const ended = ban.status?.kind === "expired" || ban.status?.kind === "lifted";
        return (
          <li key={ban.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-mono text-sm">{ban.ip}</p>
              <BanReason ban={ban} permanent={permanent} ended={ended} showCreated={showCreated} />
              <BlockedLine ban={ban} />
              <ReportedLink ban={ban} />
            </div>
            {ended && (canBanAgain || allowUrl) && (
              <div className="flex shrink-0 items-center gap-2">
                {canBanAgain && (
                  <Button size="sm" variant="outline" onClick={() => void banAgain(ban)} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : "Ban again"}
                  </Button>
                )}
                {allowUrl && <AllowButton ip={ban.ip} busy={busy} onConfirm={() => void allow(ban)} />}
              </div>
            )}
            {!ended && (canUnban || allowUrl || (canBanPermanently && !permanent)) && (
              <div className="flex shrink-0 items-center gap-2">
                {allowUrl && <AllowButton ip={ban.ip} busy={busy} onConfirm={() => void allow(ban)} />}
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

function AllowButton({ ip, busy, onConfirm }: { ip: string; busy: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={busy}>
          Allow
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Allow {ip}?</AlertDialogTitle>
          <AlertDialogDescription>
            Lifts any ban and adds the address to the never-ban list. It won&apos;t be banned or reported again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Allow</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BlockedLine({ ban }: { ban: BanItem }) {
  if (ban.blockedCount === undefined) return null;
  if (ban.blockedCount === 0) return <p className="text-xs text-muted-foreground">Not blocked yet</p>;
  return (
    <p className="text-xs text-muted-foreground">
      Blocked {ban.blockedCount.toLocaleString("en-US")} {ban.blockedCount === 1 ? "time" : "times"}
      {ban.lastBlockedAt && <>, last <RelativeTime date={ban.lastBlockedAt} /></>}
    </p>
  );
}

function ReportedLink({ ban }: { ban: BanItem }) {
  const link = ban.reportedTo ? reporterLink(ban.reportedTo, ban.ip) : null;
  if (!link) return null;
  return (
    <p className="text-xs text-muted-foreground">
      <a href={link.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">
        Reported to {link.label}
      </a>
    </p>
  );
}

/** Why the address is banned and until when. Expands to the paths it probed. */
function BanReason({ ban, permanent, ended, showCreated }: { ban: BanItem; permanent: boolean; ended: boolean; showCreated: boolean }) {
  const [open, setOpen] = useState(false);
  const paths = ban.detail?.paths ?? [];
  const reason = banReasonLine(ban);
  const status = ended ? (
    <span>{ban.status?.label}</span>
  ) : permanent ? (
    <span className="font-medium text-foreground">Permanent</span>
  ) : (
    <>
      ends <RelativeTime date={ban.expiresAt} />
    </>
  );
  const until = showCreated ? (
    <>
      {status} · banned <RelativeTime date={ban.createdAt} />
    </>
  ) : (
    status
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
