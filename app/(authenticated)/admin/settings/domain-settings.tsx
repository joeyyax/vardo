"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, X, Loader2, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { useVerify } from "@/hooks/use-verify";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MASK_SENTINEL } from "@/lib/mask-secrets";
import { useSystemSetting } from "./use-system-setting";
import { GuideLink, FieldHint } from "@/components/setup/provider-guide";

type DnsCheck = {
  domain: string;
  resolved: boolean;
  ips: string[];
  matches: boolean;
  proxied?: boolean;
  reachable?: boolean;
  proxyProvider?: "cloudflare" | null;
};

type InstanceData = {
  baseDomain: string;
  serverIp: string;
  domain: string;
  instanceName: string;
};

const ISSUER_LABELS: Record<string, string> = {
  le: "Let's Encrypt",
  google: "Google Trust Services",
  zerossl: "ZeroSSL",
};

function toDisplay(value: string): string {
  if (value.startsWith(MASK_SENTINEL)) {
    return `••••${value.slice(MASK_SENTINEL.length)}`;
  }
  return value;
}

export function DomainSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [instance, setInstance] = useState<InstanceData>({ baseDomain: "", serverIp: "", domain: "", instanceName: "" });
  const [acmeEmail, setAcmeEmail] = useState("");
  const [dnsChecks, setDnsChecks] = useState<DnsCheck[]>([]);

  // SSL issuer settings
  const [sslIssuer, setSslIssuer] = useState<string>("le");
  const [zerosslKid, setZerosslKid] = useState("");
  const [zerosslHmac, setZerosslHmac] = useState("");

  const { verify: verifySsl, verifying: verifyingSsl, result: sslVerifyResult, reset: resetSslVerify } = useVerify("/api/setup/ssl/verify");

  const onSslLoad = useCallback((data: Record<string, unknown>) => {
    setSslIssuer((data.defaultIssuer as string) || "le");
    setZerosslKid((data.zerosslEabKid as string) || "");
    setZerosslHmac((data.zerosslEabHmac as string) || "");
  }, []);

  const { loading: sslLoading, saving: sslSaving, save: saveSsl } = useSystemSetting(
    "/api/setup/ssl",
    { label: "SSL settings", onLoad: onSslLoad },
  );

  useEffect(() => {
    (async () => {
      try {
        const [generalRes, dnsRes] = await Promise.all([
          fetch("/api/setup/general"),
          fetch("/api/v1/admin/dns-check"),
        ]);

        if (generalRes.ok) {
          const data = await generalRes.json();
          setInstance({
            baseDomain: data.baseDomain ?? "",
            serverIp: data.serverIp ?? "",
            domain: data.domain ?? "",
            instanceName: data.instanceName ?? "",
          });
        }

        if (dnsRes.ok) {
          const data = await dnsRes.json();
          setDnsChecks(data.checks ?? []);
          if (data.serverIp) {
            setInstance((prev) => ({ ...prev, serverIp: prev.serverIp || data.serverIp }));
          }
        }
      } catch {
        // best effort
      } finally {
        setLoading(false);
      }
    })();

    setAcmeEmail(process.env.NEXT_PUBLIC_ACME_EMAIL ?? "");
  }, []);

  async function saveDomainSettings() {
    setSaving(true);
    try {
      const res = await fetch("/api/setup/general", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceName: instance.instanceName,
          baseDomain: instance.baseDomain,
          serverIp: instance.serverIp,
          domain: instance.domain,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }
      const { toast } = await import("sonner");
      toast.success("Domain settings saved");
      // Re-check DNS with updated values
      recheckDns();
    } catch (err) {
      const { toast } = await import("sonner");
      toast.error(err instanceof Error ? err.message : "Failed to save domain settings");
    } finally {
      setSaving(false);
    }
  }

  async function recheckDns() {
    setChecking(true);
    try {
      const res = await fetch("/api/v1/admin/dns-check");
      if (res.ok) {
        const data = await res.json();
        setDnsChecks(data.checks ?? []);
      }
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading domain settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Domain & SSL</h2>
        <p className="text-sm text-muted-foreground">
          DNS configuration and SSL certificate status for your instance.
        </p>
      </div>

      {/* Domain configuration */}
      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">Domain info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-host-domain">Primary domain</Label>
            <Input
              id="sys-host-domain"
              value={instance.domain}
              onChange={(e) => setInstance((prev) => ({ ...prev, domain: e.target.value }))}
              placeholder="vardo.example.com"
            />
            <p className="text-xs text-muted-foreground">
              The domain where this Vardo instance is accessible.
            </p>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-base-domain-dns">Base domain</Label>
            <Input
              id="sys-base-domain-dns"
              value={instance.baseDomain}
              onChange={(e) => setInstance((prev) => ({ ...prev, baseDomain: e.target.value }))}
              placeholder="example.com"
            />
            <p className="text-xs text-muted-foreground">
              Wildcard domain used for auto-generated app subdomains.
            </p>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-server-ip-dns">Server IP</Label>
            <Input
              id="sys-server-ip-dns"
              value={instance.serverIp}
              onChange={(e) => setInstance((prev) => ({ ...prev, serverIp: e.target.value }))}
              placeholder="203.0.113.1"
            />
            <p className="text-xs text-muted-foreground">
              Public IP address of this server. DNS A records should point here.
            </p>
          </div>

          {acmeEmail && (
            <div className="max-w-md space-y-2">
              <Label htmlFor="sys-acme-email">ACME email</Label>
              <Input
                id="sys-acme-email"
                value={acmeEmail}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Used for SSL certificate issuance with {ISSUER_LABELS[sslIssuer] || "Let's Encrypt"}.
              </p>
            </div>
          )}

          <Button
            className="squircle"
            onClick={saveDomainSettings}
            disabled={saving}
          >
            {saving ? (
              <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</>
            ) : (
              "Save"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* SSL certificate issuer */}
      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">SSL certificate issuer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {sslLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading...</span>
            </div>
          ) : (
            <>
              <div className="max-w-md space-y-2">
                <Label htmlFor="ssl-issuer">Default issuer</Label>
                <Select value={sslIssuer} onValueChange={setSslIssuer}>
                  <SelectTrigger id="ssl-issuer" className="squircle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="le">Let&apos;s Encrypt</SelectItem>
                    <SelectItem value="google">Google Trust Services</SelectItem>
                    <SelectItem value="zerossl">ZeroSSL</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Certificate authority used for new domains. Can be overridden per domain.
                </p>
              </div>

              {(sslIssuer === "zerossl" || zerosslKid) && (
                <div className="max-w-md space-y-4 rounded-lg border bg-muted/30 p-4">
                  <p className="text-xs font-medium">
                    ZeroSSL requires External Account Binding (EAB) credentials.{" "}
                    <a
                      href="https://app.zerossl.com/developer"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline"
                    >
                      Get credentials
                    </a>
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="zerossl-kid">EAB Key ID</Label>
                    <Input
                      id="zerossl-kid"
                      value={toDisplay(zerosslKid)}
                      onChange={(e) => setZerosslKid(e.target.value)}
                      placeholder="EAB Key ID from ZeroSSL dashboard"
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zerossl-hmac">EAB HMAC Key</Label>
                    <Input
                      id="zerossl-hmac"
                      value={toDisplay(zerosslHmac)}
                      onChange={(e) => setZerosslHmac(e.target.value)}
                      placeholder="EAB HMAC Key from ZeroSSL dashboard"
                      className="font-mono text-sm"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  className="squircle"
                  onClick={() => {
                    resetSslVerify();
                    saveSsl({
                      defaultIssuer: sslIssuer,
                      zerosslEabKid: zerosslKid || undefined,
                      zerosslEabHmac: zerosslHmac || undefined,
                    });
                  }}
                  disabled={sslSaving}
                >
                  {sslSaving ? (
                    <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</>
                  ) : (
                    "Save"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="squircle"
                  disabled={verifyingSsl}
                  onClick={verifySsl}
                  aria-label="Test SSL configuration"
                >
                  {verifyingSsl && <Loader2 className="size-4 animate-spin" />}
                  Test
                </Button>
              </div>
              {sslVerifyResult && (
                <div
                  className={`flex items-center gap-2 text-sm ${sslVerifyResult.ok ? "text-status-success" : "text-destructive"}`}
                  role="status"
                  aria-live="polite"
                >
                  {sslVerifyResult.ok ? (
                    <CheckCircle2 className="size-4 shrink-0" />
                  ) : (
                    <XCircle className="size-4 shrink-0" />
                  )}
                  <span>{sslVerifyResult.message}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* DNS resolution checks */}
      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">DNS resolution</CardTitle>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="squircle gap-1.5"
              onClick={recheckDns}
              disabled={checking}
              aria-label="Re-check DNS"
            >
              {checking ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Re-check
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {dnsChecks.length > 0 ? (
            <div className="divide-y -mx-6">
              {dnsChecks.map((check) => (
                <div key={check.domain} className="flex items-center justify-between gap-4 px-6 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium font-mono">{check.domain}</p>
                    <p className="text-xs text-muted-foreground">
                      {check.resolved
                        ? `Resolves to ${check.ips.join(", ")}`
                        : "No DNS records found"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {check.resolved && check.matches && check.proxied ? (
                      <>
                        <Check className="size-3.5 text-status-success" />
                        <span className="text-xs font-medium text-status-success">
                          Connected (via {check.proxyProvider === "cloudflare" ? "Cloudflare" : "proxy"})
                        </span>
                      </>
                    ) : check.resolved && check.matches ? (
                      <>
                        <Check className="size-3.5 text-status-success" />
                        <span className="text-xs font-medium text-status-success">Connected</span>
                      </>
                    ) : check.resolved && !check.reachable ? (
                      <>
                        <X className="size-3.5 text-status-error" />
                        <span className="text-xs font-medium text-status-error">Not responding</span>
                      </>
                    ) : check.resolved ? (
                      <>
                        <X className="size-3.5 text-status-error" />
                        <span className="text-xs font-medium text-status-error">Wrong IP</span>
                      </>
                    ) : (
                      <>
                        <X className="size-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground">DNS not configured</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No domains configured to check.
            </p>
          )}
        </CardContent>
      </Card>

      {/* DNS setup guidance */}
      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">DNS setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1 font-mono text-xs text-muted-foreground">
            <div>
              A &nbsp;&nbsp; {instance.baseDomain || "your-domain.com"} &nbsp;&nbsp; → &nbsp; {instance.serverIp || "your server IP"}
            </div>
            <div>
              A &nbsp;&nbsp; *.{instance.baseDomain || "your-domain.com"} → &nbsp; {instance.serverIp || "your server IP"}
            </div>
          </div>
          {instance.serverIp && (
            <FieldHint>
              Your server IP is <span className="font-mono font-medium text-foreground">{instance.serverIp}</span> — both A records should point here.
            </FieldHint>
          )}
          <p className="text-xs text-muted-foreground">
            HTTPS will activate automatically once DNS propagates and your
            certificate authority issues certificates. The wildcard A record
            enables automatic subdomains for deployed apps.
          </p>
          {dnsChecks.some((c) => c.proxyProvider === "cloudflare") && (
            <div className="text-xs text-muted-foreground">
              Cloudflare proxy works for single-level subdomains (*.domain.com).
              For nested subdomains (e.g. staging.app.domain.com), set that
              record to DNS-only (gray cloud) so Traefik can issue the cert.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
