"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  X,
  Pencil,
  Loader2,
  Globe2,
  Star,
  Copy,
  Info,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { PortsManager } from "./ports-manager";

import type { Domain } from "./types";

export function AppNetworking({
  domains,
  exposedPorts,
  containerPort,
  appId,
  appName,
  orgId,
  activeTab,
  initialSubView,
}: {
  domains: Domain[];
  exposedPorts: { internal: number; external?: number; description?: string }[] | null;
  containerPort: number | null;
  appId: string;
  appName: string;
  orgId: string;
  activeTab: string;
  initialSubView?: string;
}) {
  const router = useRouter();

  const [domainOpen, setDomainOpen] = useState(false);
  const [domainSaving, setDomainSaving] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [newDomainResolver, setNewDomainResolver] = useState("");
  const [deletingDomainId, setDeletingDomainId] = useState<string | null>(null);
  const [editingDomainId, setEditingDomainId] = useState<string | null>(null);
  const [editDomainValue, setEditDomainValue] = useState("");
  const [editDomainPort, setEditDomainPort] = useState("");
  const [editDomainResolver, setEditDomainResolver] = useState("");
  const [availableIssuers, setAvailableIssuers] = useState<string[]>(["le", "google"]);
  const [dnsDomainId, setDnsDomainId] = useState<string | null>(null);
  const [domainStatuses, setDomainStatuses] = useState<Record<string, "checking" | "resolving" | "not-configured">>({});
  const [domainCheckTick, setDomainCheckTick] = useState(0);
  const [serverIP, setServerIP] = useState<string | null>(null);

  // Fetch available issuers
  useEffect(() => {
    fetch("/api/setup/ssl")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.availableIssuers) setAvailableIssuers(data.availableIssuers);
      })
      .catch(() => { /* best effort */ });
  }, []);

  function openDomainSheet(domainId: string) {
    setDnsDomainId(domainId);
    const domain = domains.find((d) => d.id === domainId);
    if (domain) {
      window.history.replaceState({}, "", `/apps/${appName}/networking/${domain.domain}`);
    }
  }

  // Open sub-view from URL (e.g. /apps/emmayax/networking/emmayax.com)
  useEffect(() => {
    if (!initialSubView) return;
    const domain = domains.find((d) => d.domain === initialSubView);
    if (domain) {
      setDnsDomainId(domain.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check domain resolution status via server-side API
  const checkAllDomains = useCallback(async () => {
    if (domains.length === 0) return;
    const autoDomain = domains.find((d) => d.domain.endsWith(".localhost"))?.domain;

    for (const domain of domains) {
      setDomainStatuses((prev) => ({ ...prev, [domain.id]: "checking" }));
      try {
        const params = new URLSearchParams({ domain: domain.domain });
        if (autoDomain && autoDomain !== domain.domain) {
          params.set("expected", autoDomain);
        }
        const res = await fetch(`/api/v1/dns-check?${params}`);
        const data = await res.json();
        setDomainStatuses((prev) => ({
          ...prev,
          [domain.id]: data.configured ? "resolving" : "not-configured",
        }));
        if (data.serverIPs?.length) {
          setServerIP(data.serverIPs[0]);
        }
      } catch {
        setDomainStatuses((prev) => ({ ...prev, [domain.id]: "not-configured" }));
      }
    }
  }, [domains]);

  // Initial check + re-check on tick
  useEffect(() => {
    checkAllDomains();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains.length, domainCheckTick]);

  // Background re-check every 30s while on the networking tab
  useEffect(() => {
    if (activeTab !== "networking") return;
    const interval = setInterval(() => checkAllDomains(), 30000);
    return () => clearInterval(interval);
  }, [activeTab, checkAllDomains]);

  async function handleSetPrimaryDomain(domainId: string) {
    try {
      for (const d of domains) {
        if (d.id === domainId && !d.isPrimary) {
          await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/domains/primary`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domainId }),
          });
          toast.success("Primary domain updated");
          router.refresh();
          return;
        }
      }
    } catch {
      toast.error("Failed to update primary domain");
    }
  }

  async function handleDomainAdd() {
    if (!newDomain.trim()) return;
    setDomainSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/domains`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: newDomain.trim(),
            port: newDomainPort ? parseInt(newDomainPort, 10) : undefined,
            ...(newDomainResolver && { certResolver: newDomainResolver }),
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to add domain");
        return;
      }
      toast.success("Domain added");
      setDomainOpen(false);
      setNewDomain("");
      setNewDomainPort("");
      setNewDomainResolver("");
      router.refresh();
    } catch {
      toast.error("Failed to add domain");
    } finally {
      setDomainSaving(false);
    }
  }

  async function handleDomainDelete(id: string) {
    setDeletingDomainId(id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/domains`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete domain");
        return;
      }
      toast.success("Domain removed");
      router.refresh();
    } catch {
      toast.error("Failed to delete domain");
    } finally {
      setDeletingDomainId(null);
    }
  }

  async function handleDomainUpdate(id: string) {
    if (!editDomainValue.trim()) return;
    setDomainSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/domains`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            domain: editDomainValue.trim(),
            port: editDomainPort ? parseInt(editDomainPort, 10) : null,
            ...(editDomainResolver !== undefined && { certResolver: editDomainResolver || "le" }),
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update domain");
        return;
      }
      toast.success("Domain updated — redeploy to apply");
      setEditingDomainId(null);
      router.refresh();
    } catch {
      toast.error("Failed to update domain");
    } finally {
      setDomainSaving(false);
    }
  }

  const autoDomain = domains.find((d) => d.domain.endsWith(".localhost"))?.domain;

  return (
    <div className="space-y-8 pt-4">
      {/* Domains */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Domains</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Route traffic to your app via custom domains.</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setNewDomain("");
              setNewDomainPort("");
              setNewDomainResolver("");
              setDomainOpen(!domainOpen);
            }}
          >
            <Plus className="mr-1.5 size-4" />
            Add Domain
          </Button>
        </div>

        {domainOpen && (
          <div className="flex items-end gap-3 rounded-lg border bg-card p-4">
            <div className="grid gap-1.5 flex-1">
              <label className="text-xs text-muted-foreground">Domain</label>
              <input
                placeholder="app.example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">Port</label>
              <input
                type="number"
                placeholder={String(containerPort || 3000)}
                value={newDomainPort}
                onChange={(e) => setNewDomainPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                className="h-9 w-24 rounded-md border bg-background px-3 text-sm font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">SSL issuer</label>
              <select
                value={newDomainResolver}
                onChange={(e) => setNewDomainResolver(e.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Default</option>
                {availableIssuers.includes("le") && <option value="le">Let&apos;s Encrypt</option>}
                {availableIssuers.includes("google") && <option value="google">Google</option>}
                {availableIssuers.includes("zerossl") && <option value="zerossl">ZeroSSL</option>}
              </select>
            </div>
            <Button size="sm" onClick={handleDomainAdd} disabled={domainSaving || !newDomain.trim()}>
              {domainSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDomainOpen(false)}>
              Cancel
            </Button>
          </div>
        )}

        {domains.length === 0 && !domainOpen ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
            <Globe2 className="size-6 text-muted-foreground/50" />
            <div className="text-center space-y-1">
              <p className="text-sm text-muted-foreground">
                Add a domain to make this app accessible over the web.
              </p>
            </div>
          </div>
        ) : domains.length > 0 && (
          <div className="space-y-2">
            {domains
              .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))
              .map((domain) => {
                const isAutoGenerated = domain.domain.endsWith(".localhost");
                const isEditing = editingDomainId === domain.id;

                if (isEditing) {
                  return (
                    <div key={domain.id} className="flex items-end gap-3 rounded-lg border bg-card p-4">
                      <div className="grid gap-1.5 flex-1">
                        <label className="text-xs text-muted-foreground">Domain</label>
                        <input
                          value={editDomainValue}
                          onChange={(e) => setEditDomainValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                          className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
                          autoFocus
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <label className="text-xs text-muted-foreground">Port</label>
                        <input
                          type="number"
                          placeholder={String(containerPort || 3000)}
                          value={editDomainPort}
                          onChange={(e) => setEditDomainPort(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                          className="h-9 w-24 rounded-md border bg-background px-3 text-sm font-mono"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <label className="text-xs text-muted-foreground">SSL issuer</label>
                        <select
                          value={editDomainResolver}
                          onChange={(e) => setEditDomainResolver(e.target.value)}
                          className="h-9 rounded-md border bg-background px-2 text-sm"
                        >
                          <option value="">Default</option>
                          {availableIssuers.includes("le") && <option value="le">Let&apos;s Encrypt</option>}
                          {availableIssuers.includes("google") && <option value="google">Google</option>}
                          {availableIssuers.includes("zerossl") && <option value="zerossl">ZeroSSL</option>}
                        </select>
                      </div>
                      <Button size="sm" onClick={() => handleDomainUpdate(domain.id)} disabled={domainSaving || !editDomainValue.trim()}>
                        {domainSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingDomainId(null)}>
                        Cancel
                      </Button>
                    </div>
                  );
                }

                return (
              <div
                key={domain.id}
                className={`squircle rounded-lg border bg-card overflow-hidden ${domain.isPrimary ? "border-primary/30" : ""}`}
              >
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {(() => {
                      const status = domainStatuses[domain.id];
                      return (
                        <button
                          type="button"
                          onClick={() => openDomainSheet(domain.id)}
                          className="flex items-center gap-1.5 shrink-0 hover:opacity-70 transition-opacity"
                        >
                          <span
                            className={`size-2 rounded-full ${
                              status === "resolving" ? "bg-status-success" :
                              status === "not-configured" ? "bg-status-warning" :
                              status === "checking" ? "bg-status-neutral animate-pulse" :
                              "bg-status-neutral"
                            }`}
                          />
                          <span className={`text-xs ${
                            status === "resolving" ? "text-status-success" :
                            status === "not-configured" ? "text-status-warning" :
                            "text-muted-foreground"
                          }`}>
                            {status === "resolving" ? "Connected" :
                             status === "not-configured" ? "Not connected" :
                             "Checking"}
                          </span>
                        </button>
                      );
                    })()}
                    <a
                      href={`${domain.domain.includes("localhost") ? "http" : "https"}://${domain.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium font-mono truncate hover:underline"
                    >
                      {domain.domain}
                    </a>
                    {domain.isPrimary && (
                      <Badge className="text-xs border-transparent bg-status-info-muted text-status-info shrink-0">
                        Primary
                      </Badge>
                    )}
                    {domain.port && (
                      <span className="text-xs text-muted-foreground">:{domain.port}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Edit domain"
                      onClick={() => {
                        setEditingDomainId(domain.id);
                        setEditDomainValue(domain.domain);
                        setEditDomainPort(domain.port?.toString() || "");
                        setEditDomainResolver(domain.certResolver || "");
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    {!isAutoGenerated && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="DNS settings"
                        onClick={() => openDomainSheet(domain.id)}
                      >
                        <Info className="size-3.5" />
                      </Button>
                    )}
                    {!domain.isPrimary && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Set as primary"
                        onClick={() => handleSetPrimaryDomain(domain.id)}
                      >
                        <Star className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={deletingDomainId === domain.id}
                      onClick={() => handleDomainDelete(domain.id)}
                    >
                      {deletingDomainId === domain.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <X className="size-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Exposed Ports */}
      <PortsManager
        ports={exposedPorts || []}
        appId={appId}
        orgId={orgId}
      />

      {/* Domain Status Sheet */}
      {(() => {
        const dnsDomain = domains.find((d) => d.id === dnsDomainId);
        if (!dnsDomain) return null;
        const status = domainStatuses[dnsDomain.id];
        const isLocal = dnsDomain.domain.endsWith(".localhost");
        return (
          <BottomSheet open={!!dnsDomainId} onOpenChange={(v) => {
            if (!v) {
              setDnsDomainId(null);
              window.history.replaceState({}, "", `/apps/${appName}/networking`);
            }
          }}>
            <BottomSheetContent>
              <BottomSheetHeader>
                <BottomSheetTitle>{isLocal ? "Domain Status" : "DNS Configuration"}</BottomSheetTitle>
                <BottomSheetDescription>
                  <span className="font-mono">{dnsDomain.domain}</span>
                </BottomSheetDescription>
              </BottomSheetHeader>
              <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
                {/* Status */}
                <div className="flex items-center gap-3">
                    <span className={`size-2.5 rounded-full ${
                      status === "resolving" ? "bg-status-success" :
                      status === "not-configured" ? "bg-status-warning" :
                      "bg-status-neutral animate-pulse"
                    }`} />
                    <span className="text-sm">
                      {isLocal
                        ? (status === "resolving" ? "Service is reachable" : status === "not-configured" ? "Service is not reachable" : "Checking...")
                        : (status === "resolving" ? "Domain is correctly pointed to this server" : status === "not-configured" ? "Domain is not pointed to this server" : "Checking domain status...")}
                    </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDomainCheckTick((t) => t + 1)}
                    disabled={status === "checking"}
                  >
                    {status === "checking" ? (
                      <><Loader2 className="mr-1 size-3 animate-spin" />Checking</>
                    ) : (
                      "Check again"
                    )}
                  </Button>
                </div>

                {isLocal ? (
                  /* Local domain info */
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      This is an auto-generated local domain routed by Traefik. It resolves automatically on this machine — no DNS configuration needed.
                    </p>
                    {status === "not-configured" && (
                      <p className="text-sm text-status-warning">
                        The service isn&apos;t responding. Make sure the app is running and the container is healthy.
                      </p>
                    )}
                  </div>
                ) : (
                  /* External domain DNS config */
                  <>
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium">Required DNS Record</h3>
                      <p className="text-xs text-muted-foreground">Use one of the following options:</p>
                      <div className="rounded-lg border bg-muted/30 divide-y">
                        <div className="grid grid-cols-3 gap-4 px-4 py-2 text-xs text-muted-foreground">
                          <span>Type</span>
                          <span>Name</span>
                          <span>Value</span>
                        </div>
                        {/* Option 1: A Record */}
                        <div className="grid grid-cols-3 gap-4 px-4 py-3 text-sm font-mono">
                          <span>A</span>
                          <span>{dnsDomain.domain}</span>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate text-muted-foreground">{serverIP || "your server IP"}</span>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(serverIP || "");
                                toast.success("Copied");
                              }}
                              className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground"
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        </div>
                        {/* Option 2: CNAME (if there's a non-localhost base domain to point to) */}
                        {autoDomain && !autoDomain.endsWith(".localhost") && (
                          <div className="grid grid-cols-3 gap-4 px-4 py-3 text-sm font-mono">
                            <span>CNAME</span>
                            <span>{dnsDomain.domain}</span>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate">{autoDomain}</span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(autoDomain);
                                  toast.success("Copied");
                                }}
                                className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="size-3" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Setup Instructions</h3>
                      <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
                        <li>Go to your domain registrar or DNS provider</li>
                        <li>Add an <span className="font-mono text-foreground">A</span> record pointing to {serverIP || "your server IP"}{autoDomain && !autoDomain.endsWith(".localhost") && <>, or a <span className="font-mono text-foreground">CNAME</span> pointing to <span className="font-mono text-foreground">{autoDomain}</span></>}</li>
                        <li>Wait for DNS propagation (can take up to 48 hours)</li>
                        <li>SSL will be automatically provisioned once the domain resolves</li>
                      </ol>
                    </div>
                  </>
                )}
              </div>
              <BottomSheetFooter>
                <Button variant="outline" onClick={() => setDnsDomainId(null)}>
                  Close
                </Button>
              </BottomSheetFooter>
            </BottomSheetContent>
          </BottomSheet>
        );
      })()}
    </div>
  );
}
