"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import type { MeshPeerSummary, ProjectInstanceSummary } from "@/lib/mesh/types";

type TransferAction = "promote" | "pull" | "clone";

export function ProjectInstances({
  projectId,
  orgId,
  peers,
  instances,
}: {
  projectId: string;
  orgId: string;
  peers: MeshPeerSummary[];
  instances: ProjectInstanceSummary[];
}) {
  const router = useRouter();
  const [transferAction, setTransferAction] = useState<TransferAction | null>(null);
  const [targetPeerId, setTargetPeerId] = useState("");
  const [environment, setEnvironment] = useState("staging");
  const [includeEnvVars, setIncludeEnvVars] = useState(false);
  const [loading, setLoading] = useState(false);

  function peerName(peerId: string | null) {
    if (!peerId) return "This instance";
    return peers.find((p) => p.id === peerId)?.name ?? "Unknown";
  }

  function peerStatus(peerId: string | null): string {
    if (!peerId) return "online";
    return peers.find((p) => p.id === peerId)?.status ?? "offline";
  }

  function statusDotClass(status: string) {
    switch (status) {
      case "running":
      case "online":
        return "bg-status-success animate-pulse";
      case "stopped":
      case "offline":
        return "bg-status-neutral";
      default:
        return "bg-status-warning";
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
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setLoading(false);
    }
  }

  // Group instances: persistent first, then dev
  const persistentInstances = instances.filter((i) => {
    if (!i.meshPeerId) return true;
    const peer = peers.find((p) => p.id === i.meshPeerId);
    return peer?.type === "persistent";
  });
  const devInstances = instances.filter((i) => {
    if (!i.meshPeerId) return false;
    const peer = peers.find((p) => p.id === i.meshPeerId);
    return peer?.type === "dev";
  });
  const allInstances = [...persistentInstances, ...devInstances];

  if (peers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Network className="size-8 text-muted-foreground" aria-hidden="true" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No connected instances</p>
          <p className="text-sm text-muted-foreground">
            Connect to other Vardo instances in Settings to promote, pull or clone projects.
          </p>
        </div>
      </div>
    );
  }

  if (allInstances.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
          <Network className="size-8 text-muted-foreground" aria-hidden="true" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium">No deployments across instances</p>
            <p className="text-sm text-muted-foreground">
              Promote, pull or clone this project to connected instances.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="squircle"
            onClick={() => {
              setTransferAction("clone");
              setTargetPeerId("");
            }}
          >
            <Copy className="size-3.5 mr-1.5" aria-hidden="true" />
            Clone to...
          </Button>
        </div>
        {renderDialog()}
      </div>
    );
  }

  function renderDialog() {
    return (
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
              {loading && <Loader2 className="size-4 animate-spin mr-1.5" aria-hidden="true" />}
              {transferAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Environment</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Instance</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {allInstances.map((inst) => {
              const status = peerStatus(inst.meshPeerId);
              return (
                <tr key={inst.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium capitalize">{inst.environment}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span className={`size-2 rounded-full ${statusDotClass(status)}`} aria-hidden="true" />
                      {peerName(inst.meshPeerId)}
                      <span className="sr-only">({status})</span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className="text-xs capitalize">
                      {inst.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="flex justify-end gap-1">
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
                          <ArrowUpRight className="size-3 mr-1" aria-hidden="true" />
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
                          <ArrowDownLeft className="size-3 mr-1" aria-hidden="true" />
                          Pull
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="squircle"
        onClick={() => {
          setTransferAction("clone");
          setTargetPeerId("");
        }}
      >
        <Copy className="size-3.5 mr-1.5" aria-hidden="true" />
        Clone to...
      </Button>

      {renderDialog()}
    </div>
  );
}
