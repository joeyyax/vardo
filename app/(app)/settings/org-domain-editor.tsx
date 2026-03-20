"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Pencil, X } from "lucide-react";

export function OrgDomainEditor({
  orgId,
  currentDomain,
  defaultDomain,
}: {
  orgId: string;
  currentDomain: string | null;
  defaultDomain: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [domain, setDomain] = useState(currentDomain || "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseDomain: domain.trim() || null }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update domain");
        return;
      }

      toast.success("Domain updated");
      setEditing(false);
      router.refresh();
    } catch {
      toast.error("Failed to update domain");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDomain(currentDomain || "");
    setEditing(false);
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Base domain for auto-generated project URLs.
        </p>
      </div>

      {editing ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="grid gap-1.5">
            <Label htmlFor="base-domain">Custom Domain</Label>
            <Input
              id="base-domain"
              type="text"
              placeholder={defaultDomain}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") handleCancel();
              }}
              className="max-w-sm font-mono"
              disabled={saving}
            />
          </div>

          <div className="rounded-md border border-dashed bg-muted/50 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              Point <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">*.yourdomain.com</code> to
              your server IP via a wildcard A record or CNAME.
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            Leave empty to use the default domain <span className="font-mono">{defaultDomain}</span>.
          </p>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-sm font-mono">
            {currentDomain || defaultDomain}
          </p>
          <span className="text-xs text-muted-foreground">
            {currentDomain ? "(custom)" : "(default)"}
          </span>
          <Button size="icon-xs" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
