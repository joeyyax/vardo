"use client";

import { useState, useCallback, useEffect } from "react";
import { Shield, ShieldAlert, ShieldCheck, RefreshCw, Loader2, AlertTriangle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/messenger";
import { RelativeTime } from "@/components/relative-time";
import type { SecurityFinding } from "@/lib/db/schema/security";

type Scan = {
  id: string;
  status: "running" | "completed" | "failed";
  trigger: "deploy" | "scheduled" | "manual";
  findings: SecurityFinding[] | null;
  criticalCount: number;
  warningCount: number;
  startedAt: string;
  completedAt: string | null;
};

function severityIcon(severity: SecurityFinding["severity"]) {
  switch (severity) {
    case "critical":
      return <ShieldAlert className="size-4 shrink-0 text-status-error" aria-hidden="true" />;
    case "warning":
      return <AlertTriangle className="size-4 shrink-0 text-status-warning" aria-hidden="true" />;
    case "info":
      return <Info className="size-4 shrink-0 text-status-info" aria-hidden="true" />;
  }
}

function severityClass(severity: SecurityFinding["severity"]) {
  switch (severity) {
    case "critical":
      return "bg-status-error-muted";
    case "warning":
      return "bg-status-warning-muted";
    case "info":
      return "bg-status-info-muted";
  }
}

function FindingCard({ finding }: { finding: SecurityFinding }) {
  return (
    <div className={`flex items-start gap-3 rounded-lg px-4 py-3 ${severityClass(finding.severity)}`}>
      {severityIcon(finding.severity)}
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-sm font-medium leading-snug">{finding.title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{finding.description}</p>
        {finding.detail && (
          <p className="text-xs font-mono text-muted-foreground/70 mt-1">{finding.detail}</p>
        )}
      </div>
    </div>
  );
}

function ScanSummary({ scan }: { scan: Scan }) {
  const findings = scan.findings ?? [];
  const critical = findings.filter((f) => f.severity === "critical");
  const warning = findings.filter((f) => f.severity === "warning");
  const info = findings.filter((f) => f.severity === "info");

  const scannedAt = scan.completedAt ?? scan.startedAt;
  const triggerLabel = scan.trigger === "deploy" ? "after deploy" : scan.trigger === "scheduled" ? "scheduled" : "manual";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {scan.status === "running" && <span className="text-status-info">Scan running...</span>}
          {scan.status === "failed" && <span className="text-status-error">Scan failed</span>}
          {scan.status === "completed" && findings.length === 0 && (
            <span className="flex items-center gap-1.5 text-status-success">
              <ShieldCheck className="size-4" aria-hidden="true" />
              No findings
            </span>
          )}
          {scan.status === "completed" && findings.length > 0 && (
            <span>
              {scan.criticalCount > 0 && (
                <span className="text-status-error font-medium mr-2">
                  {scan.criticalCount} critical
                </span>
              )}
              {scan.warningCount > 0 && (
                <span className="text-status-warning font-medium mr-2">
                  {scan.warningCount} warning
                </span>
              )}
              {info.length > 0 && (
                <span className="text-muted-foreground">
                  {info.length} info
                </span>
              )}
            </span>
          )}
        </span>
        <span className="text-xs">
          <RelativeTime date={scannedAt} /> &middot; {triggerLabel}
        </span>
      </div>

      {findings.length > 0 && (
        <div className="space-y-2">
          {/* Critical first, then warning, then info */}
          {[...critical, ...warning, ...info].map((finding, i) => (
            <FindingCard key={`${finding.type}-${finding.title}-${i}`} finding={finding} />
          ))}
        </div>
      )}
    </div>
  );
}

type BindMounts = { outsideRoots: string[]; canAllow: boolean };

type SecurityData = { scans: Scan[]; bindMounts: BindMounts };

async function requestScans(url: string): Promise<SecurityData> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Couldn't load");
    const data = await res.json();
    return { scans: data.scans, bindMounts: data.bindMounts ?? { outsideRoots: [], canAllow: false } };
  } catch {
    toast.error("Couldn't load security scans");
    return { scans: [], bindMounts: { outsideRoots: [], canAllow: false } };
  }
}

function BindMountWarnings({ bindMounts, onAllowed }: { bindMounts: BindMounts; onAllowed: () => void }) {
  const [allowing, setAllowing] = useState<string | null>(null);

  const allow = async (path: string) => {
    setAllowing(path);
    try {
      const res = await fetch("/api/v1/admin/bind-mounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Couldn't allow the path");
        return;
      }
      toast.success(`Allowed ${path}`);
      onAllowed();
    } catch {
      toast.error("Couldn't allow the path");
    } finally {
      setAllowing(null);
    }
  };

  return (
    <div className="space-y-2">
      {bindMounts.outsideRoots.map((path) => (
        <div key={path} className="flex items-start gap-3 rounded-lg bg-status-warning-muted px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-status-warning" aria-hidden="true" />
          <div className="flex-1 min-w-0 space-y-0.5">
            <p className="text-sm font-medium leading-snug">Bind mount outside the allowed host roots</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              It keeps working because the app already mounted it. New mounts outside the roots are refused.
            </p>
            <p className="text-xs font-mono text-muted-foreground/70 mt-1 break-all">{path}</p>
          </div>
          {bindMounts.canAllow && (
            <Button size="sm" variant="outline" className="shrink-0" disabled={allowing !== null} onClick={() => void allow(path)}>
              {allowing === path ? <Loader2 className="size-4 animate-spin" /> : "Allow this path"}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

type AppSecurityProps = {
  appId: string;
  orgId: string;
};

export function AppSecurity({ appId, orgId }: AppSecurityProps) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [bindMounts, setBindMounts] = useState<BindMounts>({ outsideRoots: [], canAllow: false });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const scansUrl = `/api/v1/organizations/${orgId}/apps/${appId}/security`;

  const applyScans = useCallback((data: SecurityData) => {
    setScans(data.scans);
    setBindMounts(data.bindMounts);
    setLoading(false);
  }, []);

  const fetchScans = useCallback(async () => {
    applyScans(await requestScans(scansUrl));
  }, [scansUrl, applyScans]);

  useEffect(() => {
    let cancelled = false;
    requestScans(scansUrl).then((data) => {
      if (!cancelled) applyScans(data);
    });
    return () => {
      cancelled = true;
    };
  }, [scansUrl, applyScans]);

  // Poll while the latest scan is still running.
  useEffect(() => {
    if (!scans || scans[0]?.status !== "running") return;
    const timer = setInterval(() => void fetchScans(), 5_000);
    return () => clearInterval(timer);
  }, [scans, fetchScans]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/security/scan`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Scan failed");
        return;
      }
      toast.success("Scan complete");
      await fetchScans();
    } catch {
      toast.error("Scan failed");
    } finally {
      setScanning(false);
    }
  }, [orgId, appId, fetchScans]);

  const latest = scans?.[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Scans run automatically after each deploy and daily. Results surface exposed files, missing
            security headers, open sensitive ports and TLS issues.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleScan}
          disabled={scanning}
          className="shrink-0"
        >
          {scanning ? (
            <><Loader2 className="mr-1.5 size-4 animate-spin" />Scanning...</>
          ) : (
            <><RefreshCw className="mr-1.5 size-4" />Scan now</>
          )}
        </Button>
      </div>

      {bindMounts.outsideRoots.length > 0 && (
        <BindMountWarnings bindMounts={bindMounts} onAllowed={() => void fetchScans()} />
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="size-4 animate-spin" />
          Loading scan history...
        </div>
      ) : !latest ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Shield className="size-8 text-muted-foreground/30" />
          <div className="space-y-1">
            <p className="type-h4">No scans yet</p>
            <p className="text-xs text-muted-foreground">
              Scans run automatically after the first deploy. Click &ldquo;Scan now&rdquo; to run one manually.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <ScanSummary scan={latest} />

          {scans && scans.length > 1 && (
            <div className="space-y-2">
              <p className="type-label text-muted-foreground">
                Previous scans
              </p>
              <div className="space-y-4">
                {scans.slice(1).map((scan) => (
                  <div key={scan.id} className="opacity-60">
                    <ScanSummary scan={scan} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
