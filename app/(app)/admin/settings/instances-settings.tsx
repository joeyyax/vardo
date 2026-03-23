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
  Link,
  Clock,
  Timer,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type MeshInviteStatus = {
  code: string;
  expiresAt: number;
  status: "pending" | "expired";
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

function formatTimeRemaining(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "Expired";
  const mins = Math.ceil(remaining / 60_000);
  return `${mins}m remaining`;
}

export function InstancesSettings() {
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [invites, setInvites] = useState<MeshInviteStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  // Invite dialog
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Join dialog
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinToken, setJoinToken] = useState("");
  const [joinLoading, setJoinLoading] = useState(false);

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
      setInvites((json.invites ?? []).filter((i: MeshInviteStatus) => i.status === "pending"));
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
      setInviteToken(json.token);
    } catch {
      setInviteError("Failed to generate invite");
    } finally {
      setInviteLoading(false);
    }
  }

  function handleCloseInvite() {
    setInviteOpen(false);
    setInviteToken(null);
    setInviteError(null);
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setJoinLoading(true);
    try {
      const res = await fetch("/api/v1/admin/mesh/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: joinToken.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to join mesh");
        return;
      }
      toast.success("Connected to mesh");
      setJoinOpen(false);
      setJoinToken("");
      fetchPeers(true);
    } catch {
      toast.error("Failed to join mesh");
    } finally {
      setJoinLoading(false);
    }
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left column — info + actions */}
        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">Instances</h2>
            <p className="text-sm text-muted-foreground">
              Connect multiple Vardo instances into a mesh network. Instances sync
              project data over encrypted WireGuard tunnels.
            </p>
          </div>

          <Card className="squircle rounded-lg">
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <h3 className="text-sm font-medium">How it works</h3>
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>Generate an invite token on the hub instance</li>
                  <li>Paste the token on the joining instance using "Join mesh"</li>
                  <li>Both instances connect via an encrypted WireGuard tunnel</li>
                  <li>Project data syncs automatically between connected instances</li>
                </ol>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Use cases</h3>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>Staging + production pairs with project sync</li>
                  <li>Multi-server deployments across regions</li>
                  <li>Local dev environments connected to a remote instance</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="squircle"
              onClick={() => setJoinOpen(true)}
            >
              <Link className="size-4" />
              Join mesh
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

        {/* Right column — peer list + invites */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Connected instances</h3>
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
          </div>

          {/* Pending invites */}
          {invites.length > 0 && (
            <Card className="squircle rounded-lg border-dashed">
              <CardContent className="p-0">
                <div className="divide-y">
                  {invites.map((invite) => (
                    <div
                      key={invite.code}
                      className="flex items-center justify-between gap-4 px-6 py-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Timer className="size-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-muted-foreground">
                            Pending invite
                          </p>
                          <p className="text-xs text-muted-foreground/70 font-mono">
                            {invite.code}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Clock className="size-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {formatTimeRemaining(invite.expiresAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Peer list */}
          {peers.length === 0 && invites.length === 0 ? (
            <Card className="squircle rounded-lg">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Network className="size-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm font-medium">No instances connected</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Generate an invite or join an existing mesh to get started.
                </p>
              </CardContent>
            </Card>
          ) : peers.length > 0 ? (
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
          ) : null}
        </div>
      </div>

      {/* Generate invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => !open && handleCloseInvite()}>
        <DialogContent className="squircle sm:max-w-md">
          {inviteLoading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Generating invite...</p>
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
          ) : inviteToken ? (
            <>
              <DialogHeader>
                <DialogTitle>Invite token</DialogTitle>
                <DialogDescription>
                  Copy this token and paste it into the "Join mesh" dialog on the other
                  instance. Expires in 15 minutes, one-time use.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {inviteToken}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Copy invite token"
                  onClick={() => copyToClipboard(inviteToken, "Invite token")}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <DialogFooter>
                <Button className="squircle" onClick={handleCloseInvite}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Join mesh dialog */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="squircle sm:max-w-md">
          <form onSubmit={handleJoin}>
            <DialogHeader>
              <DialogTitle>Join mesh</DialogTitle>
              <DialogDescription>
                Paste the invite token from the other instance to connect this
                instance to the mesh.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-4">
              <Label htmlFor="join-token">Invite token</Label>
              <Input
                id="join-token"
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)}
                placeholder="Paste invite token here"
                className="font-mono text-xs"
                required
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="squircle"
                onClick={() => {
                  setJoinOpen(false);
                  setJoinToken("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="squircle"
                disabled={joinLoading || !joinToken.trim()}
              >
                {joinLoading && <Loader2 className="size-4 animate-spin" />}
                Join
              </Button>
            </DialogFooter>
          </form>
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
