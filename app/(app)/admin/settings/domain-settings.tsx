"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Check, X, Loader2, RefreshCw } from "lucide-react";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type DnsCheck = {
  domain: string;
  resolved: boolean;
  ips: string[];
  matches: boolean;
};

type InstanceData = {
  baseDomain: string;
  serverIp: string;
};

export function DomainSettings() {
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [instance, setInstance] = useState<InstanceData>({ baseDomain: "", serverIp: "" });
  const [hostDomain, setHostDomain] = useState("");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [dnsChecks, setDnsChecks] = useState<DnsCheck[]>([]);

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
          });
        }

        if (dnsRes.ok) {
          const data = await dnsRes.json();
          setDnsChecks(data.checks ?? []);
          if (data.serverIp) {
            setInstance((prev) => ({ ...prev, serverIp: data.serverIp }));
          }
        }
      } catch {
        // best effort
      } finally {
        setLoading(false);
      }
    })();

    // These are only available server-side via env vars, so we infer from
    // the general endpoint or accept them as empty in dev
    setHostDomain(typeof window !== "undefined" ? window.location.hostname : "");
    setAcmeEmail(process.env.NEXT_PUBLIC_ACME_EMAIL ?? "");
  }, []);

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

      {/* Domain configuration (read-only) */}
      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">Domain info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-host-domain">Primary domain</Label>
            <Input
              id="sys-host-domain"
              value={hostDomain || "Not configured"}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Set at install time via the VARDO_DOMAIN environment variable.
            </p>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-base-domain-dns">Base domain</Label>
            <Input
              id="sys-base-domain-dns"
              value={instance.baseDomain || "Not configured"}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Wildcard domain used for auto-generated app subdomains.
            </p>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-server-ip-dns">Server IP</Label>
            <Input
              id="sys-server-ip-dns"
              value={instance.serverIp || "Not configured"}
              disabled
              className="bg-muted"
            />
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
                Used for SSL certificate issuance with Let&apos;s Encrypt.
              </p>
            </div>
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
                    {check.resolved && check.matches ? (
                      <>
                        <Check className="size-3.5 text-status-success" />
                        <span className="text-xs font-medium text-status-success">Matches</span>
                      </>
                    ) : check.resolved ? (
                      <>
                        <X className="size-3.5 text-status-error" />
                        <span className="text-xs font-medium text-status-error">Wrong IP</span>
                      </>
                    ) : (
                      <>
                        <X className="size-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground">Not resolved</span>
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
              A &nbsp;&nbsp; your-domain.com &nbsp;&nbsp; → &nbsp; {instance.serverIp || "your server IP"}
            </div>
            <div>
              A &nbsp;&nbsp; *.your-domain.com → &nbsp; {instance.serverIp || "your server IP"}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            HTTPS will activate automatically once DNS propagates and Let&apos;s
            Encrypt issues certificates. The wildcard A record enables automatic
            subdomains for deployed apps.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
