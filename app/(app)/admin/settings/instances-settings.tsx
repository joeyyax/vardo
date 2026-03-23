"use client";

import { useState, useEffect } from "react";
import {
  Loader2,
  RefreshCw,
  Plus,
  MoreHorizontal,
  Trash2,
  Copy,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { toast } from "@/lib/messenger";

type MeshPeer = {
  id: string;
  instanceId: string;
  name: string;
  type: "persistent" | "dev";
  status: "online" | "offline";
  endpoint: string | null;
  publicKey: string;
  allowedIps: string;
  internalIp: string;
  apiUrl: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Failed to copy to clipboard");
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "Awaiting first heartbeat";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function InstancesSettings() {
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  // Invite dialog
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<MeshPeer | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchPeers(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/v1/admin/mesh/peers");
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      setPeers(json.peers ?? []);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchPeers();
  }, []);

  async function handleGenerateInvite() {
    setInviteLoading(true);
    setInviteError(null);
    setInviteOpen(true);
    try {
      const res = await fetch("/api/v1/admin/mesh/invite", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        setInviteError(json.error || "Failed to generate invite");
        return;
      }
      setInviteCode(json.code);
    } catch {
      setInviteError("Failed to generate invite");
    } finally {
      setInviteLoading(false);
    }
  }

  function handleCloseInvite() {
    setInviteOpen(false);
    setInviteCode(null);
    setInviteError(null);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/admin/mesh/peers/${deleteTarget.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const json = await res.json();
        toast.error(json.error || "Failed to remove peer");
        return;
      }
      setPeers((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      toast.success(`Removed ${deleteTarget.name}`);
    } catch {
      toast.error("Failed to remove peer");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading instances</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Unable to load instances.</p>
        <Button variant="outline" className="squircle" onClick={() => fetchPeers(true)}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">Instances</h2>
          <p className="text-sm text-muted-foreground">
            Mesh peers connected via WireGuard. Generate invite codes to add new instances.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchPeers(true)}
            disabled={refreshing}
            aria-label="Refresh instances"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            className="squircle"
            onClick={handleGenerateInvite}
          >
            <Plus className="size-4" />
            Generate invite
          </Button>
        </div>
      </div>

      {/* Peer list */}
      {peers.length === 0 ? (
        <Card className="squircle rounded-lg">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Network className="size-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm font-medium">No instances connected</p>
            <p className="text-sm text-muted-foreground mt-1">
              Generate an invite code to connect your first instance to the mesh.
            </p>
            <Button
              size="sm"
              className="squircle mt-4"
              onClick={handleGenerateInvite}
            >
              <Plus className="size-4" />
              Generate invite
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="squircle rounded-lg">
          <CardContent className="p-0">
            <div className="divide-y">
              {peers.map((peer) => (
                <div
                  key={peer.id}
                  className="flex items-center justify-between gap-4 px-6 py-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        peer.status === "online"
                          ? "bg-status-success"
                          : "bg-status-neutral"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="sr-only">{peer.status === "online" ? "Online" : "Offline"}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">
                          {peer.name}
                        </p>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {peer.type}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                        <span className="font-mono">{peer.internalIp}</span>
                        {peer.endpoint && (
                          <span className="font-mono">{peer.endpoint}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(peer.lastSeenAt)}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-8 p-0"
                          aria-label={`Actions for ${peer.name}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="squircle">
                        <DropdownMenuItem
                          onClick={() => copyToClipboard(peer.publicKey, "Public key")}
                        >
                          <Copy className="size-4" />
                          Copy public key
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(peer)}
                        >
                          <Trash2 className="size-4" />
                          Remove peer
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Invite code dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => !open && handleCloseInvite()}>
        <DialogContent className="squircle sm:max-w-md">
          {inviteLoading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Generating invite code...</p>
            </div>
          ) : inviteError ? (
            <>
              <DialogHeader>
                <DialogTitle>Could not generate invite</DialogTitle>
                <DialogDescription>{inviteError}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button className="squircle" onClick={handleCloseInvite}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : inviteCode ? (
            <>
              <DialogHeader>
                <DialogTitle>Invite code</DialogTitle>
                <DialogDescription>
                  Run this command on the instance you want to connect. Expires in 15 minutes, one-time use.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">
                  vardo join {inviteCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Copy join command"
                  onClick={() => copyToClipboard(`vardo join ${inviteCode}`, "Join command")}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Run this on the remote instance where Vardo is installed.
              </p>
              <DialogFooter>
                <Button className="squircle" onClick={handleCloseInvite}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Remove instance"
        description={`Remove "${deleteTarget?.name}" from the mesh? This will delete all project instance mappings for this peer. The peer's WireGuard tunnel will stop working.`}
        onConfirm={handleDelete}
        loading={deleting}
        confirmLabel="Remove"
        loadingLabel="Removing..."
      />
    </div>
  );
}
