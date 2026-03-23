"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, ArrowUpRight, ArrowDownLeft, Copy, Network } from "lucide-react";
import { toast } from "@/lib/messenger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MeshPeer = {
  id: string;
  name: string;
  type: string;
  status: string;
};

type ProjectInstance = {
  id: string;
  environment: string;
  gitRef: string | null;
  status: string;
  meshPeerId: string | null;
  transferredAt: Date | null;
};

type TransferAction = "promote" | "pull" | "clone";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectInstances({
  projectId,
  orgId,
  peers,
  instances,
}: {
  projectId: string;
  orgId: string;
  peers: MeshPeer[];
  instances: ProjectInstance[];
}) {
  const [transferAction, setTransferAction] = useState<TransferAction | null>(null);
  const [targetPeerId, setTargetPeerId] = useState("");
  const [environment, setEnvironment] = useState("staging");
  const [includeEnvVars, setIncludeEnvVars] = useState(false);
  const [loading, setLoading] = useState(false);

  function peerName(peerId: string | null) {
    if (!peerId) return "This instance";
    return peers.find((p) => p.id === peerId)?.name ?? "Unknown";
  }

  function peerStatus(peerId: string | null) {
    if (!peerId) return "online";
    return peers.find((p) => p.id === peerId)?.status ?? "offline";
  }

  function statusColor(status: string) {
    switch (status) {
      case "running": return "bg-green-500";
      case "online": return "bg-green-500";
      case "stopped": return "bg-zinc-400";
      case "offline": return "bg-zinc-400";
      default: return "bg-yellow-500";
    }
  }

  async function handleTransfer() {
    if (!transferAction || !targetPeerId) return;
    setLoading(true);

    try {
      const endpoint = `/api/v1/admin/mesh/${transferAction}`;
      const body: Record<string, unknown> = { orgId };

      if (transferAction === "promote") {
        body.projectId = projectId;
        body.targetPeerId = targetPeerId;
        body.environment = environment;
        body.includeEnvVars = includeEnvVars;
      } else if (transferAction === "pull") {
        body.sourcePeerId = targetPeerId;
        body.projectId = projectId;
        body.environment = environment;
        body.includeEnvVars = includeEnvVars;
      } else if (transferAction === "clone") {
        body.sourcePeerId = targetPeerId;
        body.projectId = projectId;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        let message = "Transfer failed";
        try { message = JSON.parse(text).error || message; } catch {}
        throw new Error(message);
      }

      const labels = { promote: "Promoted", pull: "Pulled", clone: "Cloned" };
      toast.success(`${labels[transferAction]} successfully`);
      setTransferAction(null);
      setTargetPeerId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setLoading(false);
    }
  }

  // Group instances: persistent first, then dev
  const persistentInstances = instances.filter((i) => {
    if (!i.meshPeerId) return true; // local
    const peer = peers.find((p) => p.id === i.meshPeerId);
    return peer?.type === "persistent";
  });
  const devInstances = instances.filter((i) => {
    if (!i.meshPeerId) return false;
    const peer = peers.find((p) => p.id === i.meshPeerId);
    return peer?.type === "dev";
  });

  if (peers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Network className="size-8 text-muted-foreground" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No connected instances</p>
          <p className="text-sm text-muted-foreground">
            Connect to other Vardo instances in Settings to promote, pull or clone projects.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Instances table */}
      <div className="rounded-lg border">
        <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-4 border-b px-4 py-2 text-xs font-medium text-muted-foreground">
          <div>Environment</div>
          <div>Instance</div>
          <div>Status</div>
          <div>Actions</div>
        </div>

        {[...persistentInstances, ...devInstances].map((inst) => (
          <div key={inst.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-4 items-center border-b last:border-0 px-4 py-3">
            <div className="text-sm font-medium capitalize">{inst.environment}</div>
            <div className="flex items-center gap-2 text-sm">
              <div className={`size-2 rounded-full ${statusColor(peerStatus(inst.meshPeerId))}`} />
              {peerName(inst.meshPeerId)}
            </div>
            <Badge variant="secondary" className="text-xs capitalize">
              {inst.status}
            </Badge>
            <div className="flex gap-1">
              {inst.environment !== "production" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setTransferAction("promote");
                    setTargetPeerId("");
                    setEnvironment(inst.environment === "development" ? "staging" : "production");
                  }}
                >
                  <ArrowUpRight className="size-3 mr-1" />
                  Promote
                </Button>
              )}
              {inst.environment !== "development" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setTransferAction("pull");
                    setTargetPeerId(inst.meshPeerId ?? "");
                  }}
                >
                  <ArrowDownLeft className="size-3 mr-1" />
                  Pull
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Clone button */}
      <Button
        variant="outline"
        size="sm"
        className="squircle"
        onClick={() => {
          setTransferAction("clone");
          setTargetPeerId("");
        }}
      >
        <Copy className="size-3.5 mr-1.5" />
        Clone to...
      </Button>

      {/* Transfer dialog */}
      <Dialog open={!!transferAction} onOpenChange={(open) => !open && setTransferAction(null)}>
        <DialogContent className="squircle">
          <DialogHeader>
            <DialogTitle className="capitalize">{transferAction} project</DialogTitle>
            <DialogDescription>
              {transferAction === "promote" && "Push this project to a higher environment on another instance."}
              {transferAction === "pull" && "Pull this project from another instance for local development."}
              {transferAction === "clone" && "Create a fresh copy of this project on another instance."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{transferAction === "pull" ? "Source instance" : "Target instance"}</Label>
              <Select value={targetPeerId} onValueChange={setTargetPeerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an instance" />
                </SelectTrigger>
                <SelectContent>
                  {peers
                    .filter((p) => p.status === "online")
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.type})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {transferAction !== "clone" && (
              <div className="space-y-2">
                <Label>Environment</Label>
                <Select value={environment} onValueChange={setEnvironment}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="production">Production</SelectItem>
                    <SelectItem value="staging">Staging</SelectItem>
                    <SelectItem value="development">Development</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {transferAction !== "clone" && (
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="include-env">Include environment variables</Label>
                  <p className="text-xs text-muted-foreground">
                    Secrets may need to be re-entered on the target instance.
                  </p>
                </div>
                <Switch
                  id="include-env"
                  checked={includeEnvVars}
                  onCheckedChange={setIncludeEnvVars}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="squircle"
              onClick={() => setTransferAction(null)}
            >
              Cancel
            </Button>
            <Button
              className="squircle capitalize"
              disabled={loading || !targetPeerId}
              onClick={handleTransfer}
            >
              {loading && <Loader2 className="size-4 animate-spin mr-1.5" />}
              {transferAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
