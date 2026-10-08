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
import { toast } from "@/lib/messenger";
import { OwnershipChallenge, runOwnershipCheck } from "@/components/ssl/ownership-challenge";
import type { OwnershipState } from "@/components/ssl/domain-diagnosis";
import { Card, CardContent } from "@/components/ui/card";
import {
  Globe,
  Plus,
  Trash2,
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
  verification: { state: OwnershipState; recordName: string; recordValue: string | null };
}

async function requestDomains(orgId: string): Promise<OrgDomain[] | null> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/domains`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    return data.domains;
  } catch {
    toast.error("Couldn't load domains");
    return null;
  }
}

export function OrgDomainEditor({
  orgId,
  defaultDomain,
  sslEnabled,
  serverIP,
}: {
  orgId: string;
  defaultDomain: string;
  sslEnabled: boolean;
  serverIP?: string;
}) {
  const router = useRouter();
  const [domains, setDomains] = useState<OrgDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const applyDomains = useCallback((list: OrgDomain[] | null) => {
    if (list) setDomains(list);
    setLoading(false);
  }, []);

  const fetchDomains = useCallback(async () => {
    applyDomains(await requestDomains(orgId));
  }, [orgId, applyDomains]);

  useEffect(() => {
    let cancelled = false;
    requestDomains(orgId).then((list) => {
      if (!cancelled) applyDomains(list);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, applyDomains]);

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
        toast.error(data.error || "Couldn't update domain");
        return;
      }

      const data = await res.json();
      setDomains((ds) =>
        ds.map((d) => (d.id === domain.id ? { ...d, ...data.domain } : d))
      );
      router.refresh();
    } catch {
      setDomains(prev);
      toast.error("Couldn't update domain");
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
        toast.error(data.error || "Couldn't add domain");
        return;
      }

      toast.success("Domain added");
      setNewDomain("");
      setAddOpen(false);
      fetchDomains();
      router.refresh();
    } catch {
      toast.error("Couldn't add domain");
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domain: OrgDomain) {
    setVerifying(domain.id);
    const result = await runOwnershipCheck(`/api/v1/organizations/${orgId}/domains/verify`, { id: domain.id });
    setVerifying(null);
    if (!result) return;
    setDomains((ds) =>
      ds.map((d) =>
        d.id === domain.id
          ? { ...d, verified: result.verified, verification: { ...d.verification, state: result.verified ? "verified" : "pending" } }
          : d,
      ),
    );
    router.refresh();
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
        toast.error(data.error || "Couldn't remove domain");
        return;
      }

      toast.success("Domain removed");
      setDomains((ds) => ds.filter((d) => d.id !== domain.id));
      router.refresh();
    } catch {
      toast.error("Couldn't remove domain");
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
    <Card>
      <CardContent className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Manage domains for auto-generated project URLs. Projects can use any
          enabled domain.
        </p>
      </div>

      {/* Default app domain */}
      {defaultDomainEntry && (
        <Card variant="inset" className="p-4">
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
                    <Shield className="size-3.5 text-status-success shrink-0" />
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
        </Card>
      )}

      {/* Custom domains */}
      {customDomains.length > 0 && (
        <div className="space-y-2">
          {customDomains.map((domain) => (
            <Card variant="inset"
              key={domain.id}
            >
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <Globe className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono truncate">
                        *.{domain.domain}
                      </p>
                      {domain.verification.state === "verified" && (
                        <Badge variant="success" className="shrink-0">
                          <CheckCircle2 className="size-3 mr-1" />
                          Verified
                        </Badge>
                      )}
                      {domain.verification.state === "pending" && (
                        <Badge variant="warning" className="shrink-0">
                          <AlertCircle className="size-3 mr-1" />
                          Not verified
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
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
              {domain.verification.state === "pending" && (
                <OwnershipChallenge
                  recordName={domain.verification.recordName}
                  recordValue={domain.verification.recordValue}
                  checking={verifying === domain.id}
                  onCheck={() => handleVerify(domain)}
                />
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Add domain button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setAddOpen(true)}
      >
        <Plus className="size-4 mr-1.5" />
        Add domain
      </Button>

      </CardContent>

      {/* Add domain bottom sheet */}
      <BottomSheet open={addOpen} onOpenChange={setAddOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add custom domain</BottomSheetTitle>
            <BottomSheetDescription>
              Add a custom domain for project URLs. You will need to configure
              wildcard DNS for the domain and add a TXT record to verify you
              own it.
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

            <Card variant="inset" className="px-4 py-3 space-y-3">
              <p className="type-h4">DNS setup instructions</p>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Add a wildcard DNS record pointing to this server. Choose one
                  option:
                </p>
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2">
                    <span className="type-label text-muted-foreground mt-1 shrink-0">
                      A Record:
                    </span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      *.{newDomain || "yourdomain.com"} → {serverIP || "your-server-ip"}
                    </code>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="type-label text-muted-foreground mt-1 shrink-0">
                      CNAME:
                    </span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      *.{newDomain || "yourdomain.com"} → {defaultDomain}
                    </code>
                  </div>
                </div>
              </div>
            </Card>
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
            >
              {adding ? "Adding..." : "Add domain"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </Card>
  );
}
