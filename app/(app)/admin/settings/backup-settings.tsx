"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Check, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MASK_SENTINEL } from "@/lib/mask-secrets";
import { useSystemSetting } from "./use-system-setting";

function toDisplay(value: string): string {
  if (value.startsWith(MASK_SENTINEL)) {
    return `••••${value.slice(MASK_SENTINEL.length)}`;
  }
  return value;
}

function isMaskedValue(value: string): boolean {
  return typeof value === "string" && value.startsWith(MASK_SENTINEL);
}

export function BackupSettings() {
  const [type, setType] = useState("s3");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");

  const [editingAccessKey, setEditingAccessKey] = useState(false);
  const [editingSecretKey, setEditingSecretKey] = useState(false);

  const maskedAccessKey = useRef("");
  const maskedSecretKey = useRef("");

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
      setType((data.type as string) || "s3");
      setBucket((data.bucket as string) || "");
      setRegion((data.region as string) || "");
      setEndpoint((data.endpoint as string) || "");
      const ak = (data.accessKey as string) || "";
      const sk = (data.secretKey as string) || "";
      setAccessKey(ak);
      setSecretKey(sk);
      maskedAccessKey.current = ak;
      maskedSecretKey.current = sk;
      setEditingAccessKey(false);
      setEditingSecretKey(false);
    },
    [],
  );

  const { loading, saving, configured, save } = useSystemSetting("/api/setup/backup", {
    label: "Backup settings",
    onLoad,
    onSaved: () => {
      setEditingAccessKey(false);
      setEditingSecretKey(false);
    },
  });

  // Finding 11: Reset fields when storage type changes
  function handleTypeChange(next: string) {
    if (next !== type) {
      setBucket("");
      setRegion("");
      setEndpoint("");
      setAccessKey("");
      setSecretKey("");
      setEditingAccessKey(false);
      setEditingSecretKey(false);
    }
    setType(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({ type, bucket, region, endpoint, accessKey, secretKey });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading backup settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Backup storage</h2>
        <p className="text-sm text-muted-foreground">
          Configure where volume snapshots are stored. Backups run on the schedules you set per-project in the Backups page.
        </p>
      </div>

    <Card className="squircle rounded-lg">
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {configured && (
            <p className="text-xs text-muted-foreground">
              Backup storage is configured. Edit fields below to update.
            </p>
          )}

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-backup-type">Storage type</Label>
            <Select value={type} onValueChange={handleTypeChange}>
              <SelectTrigger id="sys-backup-type" aria-label="Backup storage type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="s3">AWS S3</SelectItem>
                <SelectItem value="r2">Cloudflare R2</SelectItem>
                <SelectItem value="b2">Backblaze B2</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-bucket">Bucket name</Label>
            <Input
              id="sys-bucket"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="sys-region">Region</Label>
              <Input
                id="sys-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder={type === "r2" ? "auto" : "us-east-1"}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sys-endpoint">Endpoint</Label>
              <Input
                id="sys-endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={type === "s3" ? "Leave blank for AWS" : ""}
                autoComplete="url"
              />
            </div>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-accessKey">Access key</Label>
            {isMaskedValue(accessKey) && !editingAccessKey ? (
              <div className="flex gap-2">
                <Input id="sys-accessKey" value={toDisplay(accessKey)} disabled className="font-mono" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Edit access key"
                  onClick={() => {
                    setEditingAccessKey(true);
                    setAccessKey("");
                  }}
                >
                  Edit
                </Button>
              </div>
            ) : editingAccessKey ? (
              <div className="flex gap-2">
                <Input
                  id="sys-accessKey"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  required
                  autoFocus
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  onClick={() => {
                    setEditingAccessKey(false);
                    setAccessKey(maskedAccessKey.current);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Input
                id="sys-accessKey"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                required
              />
            )}
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-secretKey">Secret key</Label>
            {isMaskedValue(secretKey) && !editingSecretKey ? (
              <div className="flex gap-2">
                <Input id="sys-secretKey" value={toDisplay(secretKey)} disabled className="font-mono" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Edit secret key"
                  onClick={() => {
                    setEditingSecretKey(true);
                    setSecretKey("");
                  }}
                >
                  Edit
                </Button>
              </div>
            ) : editingSecretKey ? (
              <div className="flex gap-2">
                <Input
                  id="sys-secretKey"
                  type="password"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  autoComplete="current-password"
                  required
                  autoFocus
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  onClick={() => {
                    setEditingSecretKey(false);
                    setSecretKey(maskedSecretKey.current);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Input
                id="sys-secretKey"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
          </div>

          <Button type="submit" className="squircle" disabled={saving} aria-label="Save backup settings">
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>

      {/* How backups work */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">How it works</h3>
          <ul className="text-sm space-y-2">
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Automatic</span>{" "}
                — apps with persistent volumes get daily snapshots by default
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Offsite</span>{" "}
                — snapshots are uploaded to your S3-compatible provider, not stored on this server
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Tiered retention</span>{" "}
                — keep daily, weekly, monthly and yearly snapshots independently per job
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">One-click restore</span>{" "}
                — any snapshot can be restored directly into the running volume
              </span>
            </li>
          </ul>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Good to know</h3>
          <ul className="text-sm space-y-2">
            <li className="flex items-start gap-2.5">
              <X className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Only persistent volumes are backed up — ephemeral data is excluded</span>
            </li>
            <li className="flex items-start gap-2.5">
              <X className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Runs live — no downtime, no container restarts</span>
            </li>
            <li className="flex items-start gap-2.5">
              <X className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Manual backups can be triggered anytime from the Backups page</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
