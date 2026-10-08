"use client";

import { copyToClipboard } from "@/lib/clipboard";
import { useState, useEffect } from "react";
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
  ArrowRight,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
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
import { OwnershipChallenge, runOwnershipCheck } from "@/components/ssl/ownership-challenge";

import {
  diagnoseCert,
  diagnoseDns,
  diagnoseOwnership,
  dnsFactsFromCheck,
  type OwnershipState,
  TONE_DOT,
  TONE_TEXT,
  worstTone,
  type DnsFacts,
} from "@/components/ssl/domain-diagnosis";
import type { Domain } from "./types";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function AppNetworking({
  domains,
  exposedPorts,
  containerPort,
  appId,
  appName,
  orgId,
  activeTab,
  initialSubView,
  showPorts = true,
}: {
  domains: Domain[];
  exposedPorts: { internal: number; external?: number; description?: string }[] | null;
  containerPort: number | null;
  appId: string;
  appName: string;
  orgId: string;
  activeTab: string;
  initialSubView?: string;
  /** Off for a compose parent — published ports belong to a service. */
  showPorts?: boolean;
}) {
  const router = useRouter();

  const [domainOpen, setDomainOpen] = useState(false);
  const [domainSaving, setDomainSaving] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [newDomainResolver, setNewDomainResolver] = useState("");
  const [newDomainRedirectTo, setNewDomainRedirectTo] = useState("");
  const [newDomainRedirectCode, setNewDomainRedirectCode] = useState("301");
  const [deletingDomainId, setDeletingDomainId] = useState<string | null>(null);
  const [editingDomainId, setEditingDomainId] = useState<string | null>(null);
  const [editDomainValue, setEditDomainValue] = useState("");
  const [editDomainPort, setEditDomainPort] = useState("");
  const [editDomainResolver, setEditDomainResolver] = useState("");
  const [editDomainRedirectTo, setEditDomainRedirectTo] = useState("");
  const [editDomainRedirectCode, setEditDomainRedirectCode] = useState("301");
  const [availableIssuers, setAvailableIssuers] = useState<string[]>(["le", "google"]);
  // Open sub-view from URL (e.g. /apps/emmayax/networking/emmayax.com)
  const [dnsDomainId, setDnsDomainId] = useState<string | null>(
    () => (initialSubView && domains.find((d) => d.domain === initialSubView)?.id) || null,
  );
  const [domainChecks, setDomainChecks] = useState<Record<string, { run: string; facts: DnsFacts }>>({});
  const [domainCheckTick, setDomainCheckTick] = useState(0);
  const checkRun = `${domains.length}:${domainCheckTick}`;
  // Null while a check is running.
  const domainDns: Record<string, ReturnType<typeof diagnoseDns> | null> = {};
  for (const domain of domains) {
    const check = domainChecks[domain.id];
    domainDns[domain.id] = check?.run === checkRun ? diagnoseDns(check.facts) : null;
  }
  const [serverIP, setServerIP] = useState<string | null>(null);

  // TXT challenge state per domain (#891).
  type Ownership = { state: OwnershipState; recordName: string; recordValue: string | null };
  const [ownership, setOwnership] = useState<Record<string, Ownership>>({});
  const [checkingOwnership, setCheckingOwnership] = useState<string | null>(null);
  const domainIds = domains.map((d) => d.id).join(",");
  const verifyUrl = `/api/v1/organizations/${orgId}/apps/${appId}/domains/verify`;

  useEffect(() => {
    if (!domainIds) return;
    let cancelled = false;
    fetch(verifyUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.verification) setOwnership(data.verification);
      })
      .catch(() => { /* the badge stays hidden */ });
    return () => {
      cancelled = true;
    };
  }, [domainIds, verifyUrl]);

  async function handleOwnershipCheck(domainId: string) {
    setCheckingOwnership(domainId);
    const result = await runOwnershipCheck(verifyUrl, { id: domainId });
    setCheckingOwnership(null);
    if (!result) return;
    setOwnership((prev) => ({
      ...prev,
      [domainId]: { state: result.verified ? "verified" : "pending", recordName: result.recordName, recordValue: result.recordValue },
    }));
    if (result.verified) router.refresh();
  }

  // Certificate state for domains Traefik serves over HTTPS. Local domains have none.
  function certFor(domain: Domain) {
    if (domain.domain.endsWith(".localhost") || domain.sslEnabled === false) return null;
    return diagnoseCert(domain.certCheck);
  }

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

  // Initial check + re-check on tick
  useEffect(() => {
    if (domains.length === 0) return;
    const autoDomain = domains.find((d) => d.domain.endsWith(".localhost"))?.domain;
    let cancelled = false;

    (async () => {
      for (const domain of domains) {
        let facts: DnsFacts = { resolved: false, ips: [], matches: false, failed: true };
        try {
          const params = new URLSearchParams({ domain: domain.domain });
          if (autoDomain && autoDomain !== domain.domain) {
            params.set("expected", autoDomain);
          }
          const res = await fetch(`/api/v1/dns-check?${params}`);
          const data = await res.json();
          facts = dnsFactsFromCheck(data);
          if (data.serverIp && !cancelled) setServerIP(data.serverIp);
        } catch {
          // Reported as a failed lookup.
        }
        if (cancelled) return;
        setDomainChecks((prev) => ({ ...prev, [domain.id]: { run: checkRun, facts } }));
      }
    })();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkRun]);

  // Background re-check every 30s while on the networking tab
  useEffect(() => {
    if (activeTab !== "networking") return;
    const interval = setInterval(() => setDomainCheckTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, [activeTab]);

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
      toast.error("Couldn't update primary domain");
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
            ...(newDomainRedirectTo.trim() && {
              redirectTo: newDomainRedirectTo.trim(),
              redirectCode: parseInt(newDomainRedirectCode, 10),
            }),
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Couldn't add domain");
        return;
      }
      toast.success("Domain added");
      setDomainOpen(false);
      setNewDomain("");
      setNewDomainPort("");
      setNewDomainResolver("");
      setNewDomainRedirectTo("");
      setNewDomainRedirectCode("301");
      router.refresh();
    } catch {
      toast.error("Couldn't add domain");
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
        toast.error(data.error || "Couldn't delete domain");
        return;
      }
      toast.success("Domain removed");
      router.refresh();
    } catch {
      toast.error("Couldn't delete domain");
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
            redirectTo: editDomainRedirectTo.trim() || null,
            ...(editDomainRedirectTo.trim() && {
              redirectCode: parseInt(editDomainRedirectCode, 10) as 301 | 302,
            }),
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Couldn't update domain");
        return;
      }
      toast.success("Domain updated");
      setEditingDomainId(null);
      router.refresh();
    } catch {
      toast.error("Couldn't update domain");
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
            <h3 className="type-h3">Domains</h3>
            <p className="type-body-sm text-muted-foreground mt-1">Route traffic to your app via custom domains.</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setNewDomain("");
              setNewDomainPort("");
              setNewDomainResolver("");
              setNewDomainRedirectTo("");
              setNewDomainRedirectCode("301");
              setDomainOpen(!domainOpen);
            }}
          >
            <Plus className="mr-1.5 size-4" />
            Add domain
          </Button>
        </div>

        {domainOpen && (
          <div className="flex items-end gap-3 rounded-lg bg-background-deep p-4">
            <div className="grid gap-1.5 flex-1">
              <label className="text-xs text-muted-foreground">Domain</label>
              <Input
                placeholder="app.example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                className="font-mono"
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">Port</label>
              <Input
                type="number"
                placeholder={String(containerPort || 3000)}
                value={newDomainPort}
                onChange={(e) => setNewDomainPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                className="w-24 font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">SSL issuer</label>
              <Select value={newDomainResolver || "default"} onValueChange={(v) => setNewDomainResolver(v === "default" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  {availableIssuers.includes("le") && <SelectItem value="le">Let&apos;s Encrypt</SelectItem>}
                  {availableIssuers.includes("google") && <SelectItem value="google">Google</SelectItem>}
                  {availableIssuers.includes("zerossl") && <SelectItem value="zerossl">ZeroSSL</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 flex-1">
              <label className="text-xs text-muted-foreground">Redirect to</label>
              <Input
                type="url"
                placeholder="https://example.com"
                value={newDomainRedirectTo}
                onChange={(e) => setNewDomainRedirectTo(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                className="font-mono"
              />
            </div>
            {newDomainRedirectTo.trim() && (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground">Code</label>
                <Select value={newDomainRedirectCode} onValueChange={setNewDomainRedirectCode}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="301">301 Permanent</SelectItem>
                    <SelectItem value="302">302 Temporary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button size="sm" onClick={handleDomainAdd} disabled={domainSaving || !newDomain.trim()}>
              {domainSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDomainOpen(false)}>
              Cancel
            </Button>
          </div>
        )}

        {domains.length === 0 && !domainOpen ? (
          <EmptyState
            className="p-8"
            icon={Globe2}
            title="No domains yet"
            body="Add a domain to make this app accessible over the web."
          />
        ) : domains.length > 0 && (
          <div className="space-y-2">
            {domains
              .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))
              .map((domain) => {
                const isAutoGenerated = domain.domain.endsWith(".localhost");
                const isEditing = editingDomainId === domain.id;

                if (isEditing) {
                  return (
                    <div key={domain.id} className="flex items-end gap-3 rounded-lg bg-background-deep p-4">
                      <div className="grid gap-1.5 flex-1">
                        <label className="text-xs text-muted-foreground">Domain</label>
                        <Input
                          value={editDomainValue}
                          onChange={(e) => setEditDomainValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                          className="font-mono"
                          autoFocus
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <label className="text-xs text-muted-foreground">Port</label>
                        <Input
                          type="number"
                          placeholder={String(containerPort || 3000)}
                          value={editDomainPort}
                          onChange={(e) => setEditDomainPort(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                          className="w-24 font-mono"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <label className="text-xs text-muted-foreground">SSL issuer</label>
                        <Select value={editDomainResolver || "default"} onValueChange={(v) => setEditDomainResolver(v === "default" ? "" : v)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">Default</SelectItem>
                            {availableIssuers.includes("le") && <SelectItem value="le">Let&apos;s Encrypt</SelectItem>}
                            {availableIssuers.includes("google") && <SelectItem value="google">Google</SelectItem>}
                            {availableIssuers.includes("zerossl") && <SelectItem value="zerossl">ZeroSSL</SelectItem>}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5 flex-1">
                        <label className="text-xs text-muted-foreground">Redirect to</label>
                        <Input
                          type="url"
                          placeholder="https://example.com"
                          value={editDomainRedirectTo}
                          onChange={(e) => setEditDomainRedirectTo(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                          className="font-mono"
                        />
                      </div>
                      {editDomainRedirectTo.trim() && (
                        <div className="grid gap-1.5">
                          <label className="text-xs text-muted-foreground">Code</label>
                          <Select value={editDomainRedirectCode} onValueChange={setEditDomainRedirectCode}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="301">301 Permanent</SelectItem>
                              <SelectItem value="302">302 Temporary</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
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
              <Card
                key={domain.id}
                variant="inset"
                className={cn("overflow-hidden", domain.isPrimary && "border border-primary/30")}
              >
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {(() => {
                      const dns = domainDns[domain.id];
                      const cert = certFor(domain);
                      const tone = dns ? worstTone(dns.tone, cert?.tone ?? "success") : "neutral";
                      return (
                        <button
                          type="button"
                          onClick={() => openDomainSheet(domain.id)}
                          className="flex items-center gap-1.5 shrink-0 hover:opacity-70 transition-opacity"
                        >
                          <span className={`size-2 rounded-full ${TONE_DOT[tone]} ${dns ? "" : "animate-pulse"}`} />
                          <span className={`text-xs ${dns ? TONE_TEXT[dns.tone] : "text-muted-foreground"}`}>
                            {dns?.label ?? "Checking"}
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
                      <Badge variant="info" className="text-xs shrink-0">
                        Primary
                      </Badge>
                    )}
                    {(() => {
                      const proof = diagnoseOwnership(ownership[domain.id]?.state);
                      if (!proof) return null;
                      return <span className={`text-xs shrink-0 ${TONE_TEXT[proof.tone]}`}>{proof.label}</span>;
                    })()}
                    {(() => {
                      const cert = certFor(domain);
                      if (!cert) return null;
                      return <span className={`text-xs shrink-0 ${TONE_TEXT[cert.tone]}`}>{cert.label}</span>;
                    })()}
                    {domain.redirectTo ? (
                      <Badge variant="outline" className="text-xs gap-1 shrink-0">
                        <ArrowRight className="size-3" />
                        {domain.redirectCode ?? 301}
                        {" "}
                        {(() => { try { return new URL(domain.redirectTo).hostname; } catch { return domain.redirectTo; } })()}
                      </Badge>
                    ) : domain.port ? (
                      <span className="text-xs text-muted-foreground">:{domain.port}</span>
                    ) : null}
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
                        setEditDomainRedirectTo(domain.redirectTo || "");
                        setEditDomainRedirectCode(String(domain.redirectCode ?? 301));
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
                {ownership[domain.id]?.state === "pending" && (
                  <OwnershipChallenge
                    recordName={ownership[domain.id].recordName}
                    recordValue={ownership[domain.id].recordValue}
                    checking={checkingOwnership === domain.id}
                    onCheck={() => handleOwnershipCheck(domain.id)}
                  />
                )}
              </Card>
                );
              })}
          </div>
        )}
      </div>

      {/* Exposed Ports */}
      {showPorts && (
        <PortsManager
          ports={exposedPorts || []}
          appId={appId}
          orgId={orgId}
        />
      )}

      {/* Domain Status Sheet */}
      {(() => {
        const dnsDomain = domains.find((d) => d.id === dnsDomainId);
        if (!dnsDomain) return null;
        const dns = domainDns[dnsDomain.id];
        const cert = certFor(dnsDomain);
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
                <BottomSheetTitle>{isLocal ? "Domain status" : "DNS configuration"}</BottomSheetTitle>
                <BottomSheetDescription>
                  <span className="font-mono">{dnsDomain.domain}</span>
                </BottomSheetDescription>
              </BottomSheetHeader>
              <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
                {/* Status */}
                <div className="flex items-center gap-3">
                    <span className={`size-2.5 rounded-full ${dns ? TONE_DOT[dns.tone] : "bg-status-neutral animate-pulse"}`} />
                    <span className="text-sm">
                      {dns
                        ? isLocal
                          ? dns.tone === "success" ? "Service is reachable" : "Service isn't reachable"
                          : dns.label
                        : "Checking..."}
                    </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDomainCheckTick((t) => t + 1)}
                    disabled={!dns}
                  >
                    {!dns ? (
                      <><Loader2 className="mr-1 size-3 animate-spin" />Checking</>
                    ) : (
                      "Check again"
                    )}
                  </Button>
                </div>

                {dns?.hint && !isLocal && (
                  <p className={`text-sm ${TONE_TEXT[dns.tone]}`}>{dns.hint}</p>
                )}

                {cert && (
                  <div className="space-y-1">
                    <h3 className="type-h4">Certificate</h3>
                    <p className={`text-sm ${TONE_TEXT[cert.tone]}`}>{cert.label}</p>
                    {cert.hint && <p className="text-sm text-muted-foreground">{cert.hint}</p>}
                  </div>
                )}

                {isLocal ? (
                  /* Local domain info */
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      This is an auto-generated local domain routed by Traefik. It resolves automatically on this machine — no DNS configuration needed.
                    </p>
                    {dns && dns.tone !== "success" && (
                      <p className="text-sm text-status-warning">
                        The service isn&apos;t responding. Make sure the app is running and the container is healthy.
                      </p>
                    )}
                  </div>
                ) : (
                  /* External domain DNS config */
                  <>
                    <div className="space-y-3">
                      <h3 className="type-h4">Required DNS record</h3>
                      <p className="text-xs text-muted-foreground">Use one of the following options:</p>
                      <div className="rounded-lg bg-background-deep divide-y">
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
                              onClick={async () => {
                                if (await copyToClipboard(serverIP || "")) toast.success("Copied");
                              }}
                              className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground"
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        </div>
                        {/* Option 2: CNAME */}
                        {autoDomain && !autoDomain.endsWith(".localhost") && (
                          <div className="grid grid-cols-3 gap-4 px-4 py-3 text-sm font-mono">
                            <span>CNAME</span>
                            <span>{dnsDomain.domain}</span>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate">{autoDomain}</span>
                              <button
                                onClick={async () => {
                                  if (await copyToClipboard(autoDomain)) toast.success("Copied");
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
                      <h3 className="type-h4">Setup instructions</h3>
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
