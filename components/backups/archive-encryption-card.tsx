"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/ui/callout";
import { toast } from "@/lib/messenger";

type ArchiveEncryptionState = {
  enabled: boolean;
  keyAvailable: boolean;
};

const ENDPOINT = "/api/v1/system/backup-encryption";

/** Whether new archives are encrypted with age under the recovery key, and the toggle for that setting. */
export function ArchiveEncryptionCard({ heading = "h3" }: { heading?: "h2" | "h3" }) {
  const [state, setState] = useState<ArchiveEncryptionState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: ArchiveEncryptionState | null) => setState(body))
      .catch(() => setState(null));
  }, []);

  if (!state) return null;

  async function change(next: boolean) {
    setSaving(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body !== "object" || !("enabled" in body)) {
        const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : "Couldn't save";
        toast.error(message);
        return;
      }
      setState(body as ArchiveEncryptionState);
      toast.success("Backup encryption saved");
    } catch {
      toast.error("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const switchId = "archive-encryption";
  const disabled = saving || !state.keyAvailable;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-4">
        <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
        <CardTitle as={heading}>Archive encryption</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor={switchId}>Encrypt new backups</Label>
            <p className="text-sm text-muted-foreground">
              {state.enabled
                ? "On. Encrypted with age under this server's recovery key."
                : "Off. Changes apply to new backups only."}
            </p>
            {!state.keyAvailable ? (
              <p className="text-xs text-muted-foreground">
                Encryption needs ENCRYPTION_MASTER_KEY.
              </p>
            ) : null}
          </div>
          <Switch
            id={switchId}
            checked={state.enabled}
            disabled={disabled}
            onCheckedChange={(value) => change(value)}
          />
        </div>
        {!state.enabled ? (
          <Callout variant="warning" label="Heads up">
            New backups are readable by anyone with access to the backup storage.
          </Callout>
        ) : null}
      </CardContent>
    </Card>
  );
}
