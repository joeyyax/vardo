"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useSystemSetting } from "./use-system-setting";

export function GeneralSettings() {
  const [instanceName, setInstanceName] = useState("Vardo");
  const [baseDomain, setBaseDomain] = useState("");
  const [serverIp, setServerIp] = useState("");

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
      setInstanceName((data.instanceName as string) || "Vardo");
      setBaseDomain((data.baseDomain as string) || "");
      setServerIp((data.serverIp as string) || "");
    },
    [],
  );

  const { loading, saving, save } = useSystemSetting("/api/setup/general", {
    label: "General settings",
    onLoad,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({ instanceName });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading general settings</span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      <div className="space-y-2">
        <Label htmlFor="sys-instance-name">Instance name</Label>
        <Input
          id="sys-instance-name"
          value={instanceName}
          onChange={(e) => setInstanceName(e.target.value)}
          placeholder="Vardo"
          required
        />
        <p className="text-xs text-muted-foreground">
          Displayed in the browser tab and system emails.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sys-base-domain">Base domain</Label>
        <Input
          id="sys-base-domain"
          value={baseDomain || "Not configured"}
          disabled
          className="bg-muted"
        />
        <p className="text-xs text-muted-foreground">
          Set at install time. Change this in your environment variables.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sys-server-ip">Server IP</Label>
        <Input
          id="sys-server-ip"
          value={serverIp || "Not configured"}
          disabled
          className="bg-muted"
        />
        <p className="text-xs text-muted-foreground">
          Set at install time. Change this in your environment variables.
        </p>
      </div>

      <Button type="submit" className="squircle" disabled={saving} aria-label="Save general settings">
        {saving && <Loader2 className="size-4 animate-spin" />}
        Save
      </Button>
    </form>
  );
}
