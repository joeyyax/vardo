"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import type { BackupTarget, TargetType } from "./types";

export function TargetForm({
  open,
  onOpenChange,
  orgId,
  isFirstTarget,
  onCreated,
  editTarget,
  allowLocalBackups = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  isFirstTarget: boolean;
  onCreated: () => void;
  editTarget?: BackupTarget | null;
  allowLocalBackups?: boolean;
}) {
  const isEditing = !!editTarget;
  const config = (editTarget?.config ?? {}) as Record<string, string>;

  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(editTarget?.name ?? "");
  const [type, setType] = useState<TargetType>((editTarget?.type as TargetType) ?? "s3");

  // S3/R2/B2
  const [bucket, setBucket] = useState(config.bucket ?? "");
  const [region, setRegion] = useState(config.region ?? "");
  const [endpoint, setEndpoint] = useState(config.endpoint ?? "");
  const [accessKeyId, setAccessKeyId] = useState(config.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = useState(config.secretAccessKey ?? "");
  const [prefix, setPrefix] = useState(config.prefix ?? "");

  // SSH
  const [sshHost, setSshHost] = useState(config.host ?? "");
  const [sshPort, setSshPort] = useState(config.port ?? "");
  const [sshUsername, setSshUsername] = useState(config.username ?? "");
  const [sshPrivateKey, setSshPrivateKey] = useState(config.privateKey ?? "");
  const [sshPath, setSshPath] = useState(config.path ?? "");

  function reset() {
    setName("");
    setType("s3");
    setBucket("");
    setRegion("");
    setEndpoint("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setPrefix("");
    setSshHost("");
    setSshPort("");
    setSshUsername("");
    setSshPrivateKey("");
    setSshPath("");
  }

  function isValid(): boolean {
    if (!name.trim()) return false;
    switch (type) {
      case "s3":
        return !!(bucket.trim() && region.trim() && accessKeyId.trim() && secretAccessKey.trim());
      case "r2":
        return !!(bucket.trim() && endpoint.trim() && accessKeyId.trim() && secretAccessKey.trim());
      case "b2":
        return !!(bucket.trim() && region.trim() && accessKeyId.trim() && secretAccessKey.trim());
      case "ssh":
        return !!(sshHost.trim() && sshUsername.trim() && sshPath.trim());
    }
  }

  function buildConfig(): Record<string, unknown> {
    switch (type) {
      case "s3":
        return {
          bucket: bucket.trim(), region: region.trim(),
          ...(endpoint.trim() && { endpoint: endpoint.trim() }),
          accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(),
          ...(prefix.trim() && { prefix: prefix.trim() }),
        };
      case "r2":
        return {
          bucket: bucket.trim(), region: region.trim() || "auto",
          endpoint: endpoint.trim(),
          accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(),
          ...(prefix.trim() && { prefix: prefix.trim() }),
        };
      case "b2":
        return {
          bucket: bucket.trim(), region: region.trim(),
          endpoint: endpoint.trim(),
          accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(),
          ...(prefix.trim() && { prefix: prefix.trim() }),
        };
      case "ssh":
        return {
          host: sshHost.trim(),
          ...(sshPort.trim() && { port: parseInt(sshPort, 10) }),
          username: sshUsername.trim(),
          ...(sshPrivateKey.trim() && { privateKey: sshPrivateKey.trim() }),
          path: sshPath.trim(),
        };
    }
  }

  async function handleSubmit() {
    if (!isValid()) return;
    setSaving(true);
    try {
      const url = isEditing
        ? `/api/v1/organizations/${orgId}/backups/targets/${editTarget!.id}`
        : `/api/v1/organizations/${orgId}/backups/targets`;

      const res = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(isEditing ? {} : { type }),
          config: buildConfig(),
          ...(isEditing ? {} : { isDefault: isFirstTarget }),
        }),
      });
      if (res.ok) {
        toast.success(isEditing ? "Target updated" : "Storage target created");
        onOpenChange(false);
        if (!isEditing) reset();
        onCreated();
      } else {
        const err = await res.json();
        toast.error(err.error || `Failed to ${isEditing ? "update" : "create"} target`);
      }
    } catch {
      toast.error(`Failed to ${isEditing ? "update" : "create"} target`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent>
        <BottomSheetHeader>
          <BottomSheetTitle>{isEditing ? "Edit storage target" : "Add storage target"}</BottomSheetTitle>
          <BottomSheetDescription>
            Configure where backups will be stored. Supports S3-compatible storage, Backblaze B2, and SSH/SFTP targets.
          </BottomSheetDescription>
        </BottomSheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="target-name">Name</Label>
              <Input id="target-name" placeholder="My backup storage" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="grid gap-2">
              <Label>Target type</Label>
              <Select value={type} onValueChange={(v) => setType(v as TargetType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="s3">Amazon S3</SelectItem>
                  <SelectItem value="r2">Cloudflare R2</SelectItem>
                  <SelectItem value="b2">Backblaze B2</SelectItem>
                  {allowLocalBackups && <SelectItem value="ssh">SSH / SFTP</SelectItem>}
                </SelectContent>
              </Select>
            </div>

            {(type === "s3" || type === "r2" || type === "b2") && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="target-bucket">Bucket</Label>
                  <Input id="target-bucket" placeholder="my-backups" value={bucket} onChange={(e) => setBucket(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-region">Region</Label>
                  <Input id="target-region" placeholder={type === "r2" ? "auto" : "us-east-1"} value={region} onChange={(e) => setRegion(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-endpoint">Endpoint{type === "s3" && <span className="text-muted-foreground font-normal"> (optional)</span>}</Label>
                  <Input id="target-endpoint" placeholder={type === "r2" ? "https://{accountId}.r2.cloudflarestorage.com" : type === "b2" ? "https://s3.{region}.backblazeb2.com" : ""} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-access-key">Access key ID</Label>
                  <Input id="target-access-key" placeholder="AKIA..." value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-secret-key">Secret access key</Label>
                  <Input id="target-secret-key" type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-prefix">Prefix<span className="text-muted-foreground font-normal"> (optional)</span></Label>
                  <Input id="target-prefix" placeholder="backups/" className="font-mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
                </div>
              </>
            )}

            {type === "ssh" && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="target-ssh-host">Host</Label>
                  <Input id="target-ssh-host" placeholder="backups.example.com" value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-ssh-port">Port<span className="text-muted-foreground font-normal"> (optional, default 22)</span></Label>
                  <Input id="target-ssh-port" type="number" placeholder="22" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-ssh-username">Username</Label>
                  <Input id="target-ssh-username" placeholder="backup" value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-ssh-key">Private key<span className="text-muted-foreground font-normal"> (optional)</span></Label>
                  <Textarea id="target-ssh-key" placeholder="Paste PEM private key (optional — uses system SSH key if empty)" className="font-mono text-xs min-h-[120px]" value={sshPrivateKey} onChange={(e) => setSshPrivateKey(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="target-ssh-path">Remote path</Label>
                  <Input id="target-ssh-path" placeholder="/var/backups" className="font-mono" value={sshPath} onChange={(e) => setSshPath(e.target.value)} />
                </div>
              </>
            )}
          </div>
        </div>

        <BottomSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving || !isValid()}>
            {saving ? <><Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />{isEditing ? "Saving..." : "Creating..."}</> : isEditing ? "Save" : "Create target"}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}
