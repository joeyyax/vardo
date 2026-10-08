"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/ui/callout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useVerify } from "@/hooks/use-verify";
import { toast } from "@/lib/messenger";
import { MASK_SENTINEL, isMasked } from "@/lib/mask-secrets";
import { ProviderGuide, GuideLink, FieldHint } from "@/components/setup/provider-guide";
import { BACKUP_PROVIDER_GUIDES } from "@/lib/setup/provider-guides";

const TYPE_LABEL: Record<string, string> = { ssh: "SSH", local: "local filesystem" };

export type SystemStorage = {
  configured: boolean;
  editable: boolean;
  managedInFile: boolean;
  target: { id: string; name: string; type: string } | null;
  type?: string;
  bucket?: string | null;
  region?: string | null;
  endpoint?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  location?: string | null;
};

/** A stored credential shows as a masked, read-only value until Edit; an untouched one is sent back masked and kept. */
function SecretField({
  id,
  label,
  value,
  onChange,
  secret,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [original] = useState(value);
  const stored = isMasked(value) && !editing;
  const type = secret ? "password" : "text";

  return (
    <div className="max-w-md space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {stored ? (
        <div className="flex gap-2">
          <Input id={id} value={`••••${value.slice(MASK_SENTINEL.length)}`} disabled className="font-mono" />
          <Button type="button" variant="outline" size="sm" className="shrink-0" aria-label={`Edit ${label.toLowerCase()}`} onClick={() => { setEditing(true); onChange(""); }}>
            Edit
          </Button>
        </div>
      ) : editing ? (
        <div className="flex gap-2">
          <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} required autoFocus autoComplete="off" />
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => { setEditing(false); onChange(original); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" />
      )}
    </div>
  );
}

/** Where Vardo's own database backups go. Saving creates the database job if it's missing. */
export function SystemStorageForm({ storage, onSaved }: { storage: SystemStorage; onSaved: () => void }) {
  const [type, setType] = useState(storage.type && ["s3", "r2", "b2"].includes(storage.type) ? storage.type : "s3");
  const [bucket, setBucket] = useState(storage.bucket ?? "");
  const [region, setRegion] = useState(storage.region ?? "");
  const [endpoint, setEndpoint] = useState(storage.endpoint ?? "");
  const [accessKey, setAccessKey] = useState(storage.accessKey ?? "");
  const [secretKey, setSecretKey] = useState(storage.secretKey ?? "");
  const [saving, setSaving] = useState(false);
  const { verify, verifying, result, reset } = useVerify("/api/setup/backup/verify");

  if (storage.managedInFile) {
    return <Callout variant="info">Backup storage is set in vardo.yml. Edit it there.</Callout>;
  }
  if (!storage.editable) {
    return (
      <Callout variant="info">
        Vardo&apos;s database backs up to the {storage.target?.name} target ({TYPE_LABEL[storage.type ?? ""] ?? storage.type}
        {storage.location ? `, ${storage.location}` : ""}). Delete that target to switch to S3-compatible storage.
      </Callout>
    );
  }

  function changeType(next: string) {
    if (next === type) return;
    setType(next);
    setBucket("");
    setRegion("");
    setEndpoint("");
    setAccessKey("");
    setSecretKey("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/v1/admin/system-backup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, bucket, region, endpoint: endpoint || undefined, accessKey, secretKey }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Couldn't save backup storage");
        return;
      }
      toast.success("Backup storage saved");
      reset();
      onSaved();
    } catch {
      toast.error("Couldn't save backup storage");
    } finally {
      setSaving(false);
    }
  }

  const guide = BACKUP_PROVIDER_GUIDES[type];

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="max-w-md space-y-2">
        <Label htmlFor="sys-backup-type">Storage type</Label>
        <Select value={type} onValueChange={changeType}>
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

      {guide && !storage.configured && (
        <ProviderGuide title={`Setting up ${guide.name}`} description={guide.bucketSettings}>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div><span className="font-medium">Credentials:</span> {guide.credentialSteps}</div>
            <div><span className="font-medium">Permissions needed:</span> {guide.requiredPermissions}</div>
          </div>
          <div className="flex gap-3">
            <GuideLink href={guide.createBucketUrl}>Create bucket</GuideLink>
            <GuideLink href={guide.consoleUrl}>Console</GuideLink>
          </div>
        </ProviderGuide>
      )}

      <div className="max-w-md space-y-2">
        <Label htmlFor="sys-bucket">Bucket name</Label>
        <Input id="sys-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} required />
      </div>

      <div className="grid max-w-md grid-cols-1 gap-2 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="sys-region">Region</Label>
          <Input id="sys-region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder={type === "r2" ? "auto" : "us-east-1"} required />
          {type === "r2" && <FieldHint>Use &quot;auto&quot; for R2.</FieldHint>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="sys-endpoint">Endpoint</Label>
          <Input id="sys-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={type === "s3" ? "Leave blank for AWS" : ""} autoComplete="url" />
          {type === "r2" && <FieldHint>https://&lt;account-id&gt;.r2.cloudflarestorage.com</FieldHint>}
          {type === "b2" && <FieldHint>https://s3.&lt;region&gt;.backblazeb2.com</FieldHint>}
        </div>
      </div>

      <SecretField id="sys-accessKey" label="Access key" value={accessKey} onChange={setAccessKey} />
      <SecretField id="sys-secretKey" label="Secret key" value={secretKey} onChange={setSecretKey} secret />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Save
        </Button>
        {storage.configured && (
          <Button type="button" variant="outline" disabled={verifying} onClick={verify}>
            {verifying && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Test connection
          </Button>
        )}
      </div>
      {result && (
        <div className={`flex items-center gap-2 text-sm ${result.ok ? "text-status-success" : "text-destructive"}`} role="status" aria-live="polite">
          {result.ok ? <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" /> : <XCircle className="size-4 shrink-0" aria-hidden="true" />}
          <span>{result.message}</span>
        </div>
      )}
    </form>
  );
}
