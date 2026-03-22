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
import { Loader2 } from "lucide-react";
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
          Configure where automated backups are stored — S3, R2, or B2 compatible storage.
        </p>
      </div>

    <form onSubmit={handleSubmit} className="space-y-4">
      {configured && (
        <p className="text-xs text-muted-foreground">
          Backup storage is configured. Edit fields below to update.
        </p>
      )}

      <div className="space-y-2">
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

      <div className="space-y-2">
        <Label htmlFor="sys-bucket">Bucket name</Label>
        <Input
          id="sys-bucket"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
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

      <div className="space-y-2">
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

      <div className="space-y-2">
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
    </div>
  );
}
