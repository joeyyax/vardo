"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetClose,
} from "@/components/ui/bottom-sheet";
import { toast } from "sonner";
import {
  Globe,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Shield,
} from "lucide-react";

interface OrgDomain {
  id: string;
  organizationId: string;
  domain: string;
  isDefault: boolean | null;
  enabled: boolean;
  verified: boolean | null;
  createdAt: string;
}

export function OrgDomainEditor({
  orgId,
  defaultDomain,
  sslEnabled,
}: {
  orgId: string;
  defaultDomain: string;
  sslEnabled: boolean;
}) {
  const router = useRouter();
  const [domains, setDomains] = useState<OrgDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchDomains = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/domains`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setDomains(data.domains);
    } catch {
      toast.error("Failed to load domains");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  async function handleToggle(domain: OrgDomain) {
    const prev = domains;
    setDomains((ds) =>
      ds.map((d) => (d.id === domain.id ? { ...d, enabled: !d.enabled } : d))
    );

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/domains`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: domain.id, enabled: !domain.enabled }),
      });

      if (!res.ok) {
        setDomains(prev);
        const data = await res.json();
        toast.error(data.error || "Failed to update domain");
        return;
      }

      const data = await res.json();
      setDomains((ds) =>
        ds.map((d) => (d.id === domain.id || d.id === "__default__" ? data.domain : d))
      );
      router.refresh();
    } catch {
      setDomains(prev);
      toast.error("Failed to update domain");
    }
  }

  async function handleAdd() {
    if (!newDomain.trim()) return;
    setAdding(true);

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to add domain");
        return;
      }

      toast.success("Domain added");
      setNewDomain("");
      setAddOpen(false);
      fetchDomains();
      router.refresh();
    } catch {
      toast.error("Failed to add domain");
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domain: OrgDomain) {
    setVerifying(domain.id);

    try {
      const testDomain = `_verify.${domain.domain}`;
      const res = await fetch(
        `/api/v1/dns-check?domain=${encodeURIComponent(testDomain)}&expected=${encodeURIComponent(defaultDomain)}`
      );

      if (!res.ok) throw new Error();
      const data = await res.json();

      if (data.configured) {
        // Mark as verified via PATCH (re-use toggle endpoint conceptually;
        // we'll refetch to get fresh state)
        setDomains((ds) =>
          ds.map((d) => (d.id === domain.id ? { ...d, verified: true } : d))
        );
        toast.success("DNS verified successfully");
      } else {
        toast.error(
          "DNS not yet configured. Make sure your wildcard record is set up and has propagated."
        );
      }
    } catch {
      toast.error("Failed to check DNS");
    } finally {
      setVerifying(null);
    }
  }

  async function handleDelete(domain: OrgDomain) {
    setDeleting(domain.id);

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/domains`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: domain.id }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to remove domain");
        return;
      }

      toast.success("Domain removed");
      setDomains((ds) => ds.filter((d) => d.id !== domain.id));
      router.refresh();
    } catch {
      toast.error("Failed to remove domain");
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Loading domains...</p>
      </div>
    );
  }

  const defaultDomainEntry = domains.find((d) => d.isDefault);
  const customDomains = domains.filter((d) => !d.isDefault);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Manage domains for auto-generated project URLs. Projects can use any
          enabled domain.
        </p>
      </div>

      {/* Default app domain */}
      {defaultDomainEntry && (
        <div className="squircle rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <Globe className="size-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-mono truncate">
                    *.{defaultDomainEntry.domain}
                  </p>
                  <Badge variant="secondary" className="shrink-0">
                    Default
                  </Badge>
                  {sslEnabled && (
                    <Shield className="size-3.5 text-green-500 shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  App-provided wildcard domain
                </p>
              </div>
            </div>
            <Switch
              checked={defaultDomainEntry.enabled}
              onCheckedChange={() => handleToggle(defaultDomainEntry)}
              size="sm"
            />
          </div>
        </div>
      )}

      {/* Custom domains */}
      {customDomains.length > 0 && (
        <div className="space-y-2">
          {customDomains.map((domain) => (
            <div
              key={domain.id}
              className="squircle rounded-lg border bg-card p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <Globe className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono truncate">
                        *.{domain.domain}
                      </p>
                      {domain.verified ? (
                        <Badge
                          variant="secondary"
                          className="shrink-0 bg-green-500/10 text-green-600 border-green-500/20"
                        >
                          <CheckCircle2 className="size-3 mr-1" />
                          Verified
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="shrink-0 text-amber-600 border-amber-500/30"
                        >
                          <AlertCircle className="size-3 mr-1" />
                          Unverified
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!domain.verified && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => handleVerify(domain)}
                      disabled={verifying === domain.id}
                      title="Verify DNS"
                    >
                      <RefreshCw
                        className={`size-3.5 ${verifying === domain.id ? "animate-spin" : ""}`}
                      />
                    </Button>
                  )}
                  <Switch
                    checked={domain.enabled}
                    onCheckedChange={() => handleToggle(domain)}
                    size="sm"
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => handleDelete(domain)}
                    disabled={deleting === domain.id}
                    className="text-destructive hover:text-destructive"
                    title="Remove domain"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add domain button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setAddOpen(true)}
        className="squircle"
      >
        <Plus className="size-4 mr-1.5" />
        Add Domain
      </Button>

      {/* Add domain bottom sheet */}
      <BottomSheet open={addOpen} onOpenChange={setAddOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add Custom Domain</BottomSheetTitle>
            <BottomSheetDescription>
              Add a custom domain for project URLs. You will need to configure
              wildcard DNS for the domain.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="px-6 py-4 space-y-6 overflow-y-auto">
            <div className="grid gap-1.5">
              <Label htmlFor="custom-domain">Domain</Label>
              <Input
                id="custom-domain"
                type="text"
                placeholder="example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                className="max-w-sm font-mono"
                disabled={adding}
              />
              <p className="text-xs text-muted-foreground">
                Enter the base domain (e.g. example.com). A wildcard
                (*.example.com) will be used for project subdomains.
              </p>
            </div>

            <div className="rounded-md border border-dashed bg-muted/50 px-4 py-3 space-y-3">
              <p className="text-sm font-medium">DNS Setup Instructions</p>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Add a wildcard DNS record pointing to this server. Choose one
                  option:
                </p>
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-medium text-muted-foreground mt-0.5 shrink-0">
                      A Record:
                    </span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      *.{newDomain || "yourdomain.com"} → your-server-ip
                    </code>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-medium text-muted-foreground mt-0.5 shrink-0">
                      CNAME:
                    </span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      *.{newDomain || "yourdomain.com"} → {defaultDomain}
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <BottomSheetClose asChild>
              <Button variant="ghost" disabled={adding}>
                Cancel
              </Button>
            </BottomSheetClose>
            <Button
              onClick={handleAdd}
              disabled={adding || !newDomain.trim()}
              className="squircle"
            >
              {adding ? "Adding..." : "Add Domain"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </div>
  );
}
