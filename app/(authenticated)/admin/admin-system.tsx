"use client";

import { useState, useEffect } from "react";
import { Loader2, Check, X } from "lucide-react";
import { formatBytes } from "@/lib/metrics/format";
import type { ServiceStatus, RuntimeInfo } from "@/lib/config/health";
import type { FeatureFlagInfo } from "@/lib/config/features";

type SystemData = {
  services: ServiceStatus[];
  resources: unknown[];
  runtime: RuntimeInfo;
  auth: { passkeys: boolean; magicLink: boolean; github: boolean; passwords: boolean; twoFactor: boolean };
  featureFlags: FeatureFlagInfo[];
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function AdminSystem() {
  const [data, setData] = useState<SystemData | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/health")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      {/* Runtime — always has data from process.* (instant) */}
      <div className="squircle rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground mb-3">Server Runtime</p>
        {data ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Next.js</p>
              <p className="text-sm font-medium tabular-nums">{data.runtime.nextVersion}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Node.js</p>
              <p className="text-sm font-medium tabular-nums">{data.runtime.nodeVersion}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Uptime</p>
              <p className="text-sm font-medium tabular-nums">{formatUptime(data.runtime.uptime)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Memory (RSS)</p>
              <p className="text-sm font-medium tabular-nums">{formatBytes(data.runtime.memoryUsage)}</p>
            </div>
          </div>
        ) : (
          <div className="flex gap-4">
            {[1,2,3,4].map((i) => <div key={i} className="h-8 w-24 bg-muted rounded animate-pulse" />)}
          </div>
        )}
      </div>

      {/* Infrastructure */}
      <div className="squircle rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-2 border-b">
          <p className="text-xs text-muted-foreground">Infrastructure</p>
        </div>
        <div className="divide-y">
          {data ? (
            data.services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`size-2 rounded-full shrink-0 ${
                    svc.status === "healthy" ? "bg-status-success" :
                    svc.status === "unhealthy" ? "bg-status-error" :
                    "bg-status-neutral"
                  }`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{svc.name}</p>
                    <p className="text-xs text-muted-foreground">{svc.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {svc.latencyMs !== undefined && svc.status === "healthy" && (
                    <span className="text-xs tabular-nums text-muted-foreground">{svc.latencyMs}ms</span>
                  )}
                  <span className={`text-xs font-medium ${
                    svc.status === "healthy" ? "text-status-success" :
                    svc.status === "unhealthy" ? "text-status-error" :
                    "text-muted-foreground"
                  }`}>
                    {svc.status === "healthy" ? "Healthy" :
                     svc.status === "unhealthy" ? "Unhealthy" :
                     "Not configured"}
                  </span>
                </div>
              </div>
            ))
          ) : (
            [1,2,3,4,5,6].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="size-2 rounded-full bg-muted animate-pulse" />
                <div className="h-4 w-32 bg-muted rounded animate-pulse" />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Auth */}
      <div className="squircle rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground mb-3">Authentication</p>
        {data ? (
          <div className="flex flex-wrap gap-2">
            {([
              { label: "Passkeys", enabled: data.auth.passkeys },
              { label: "Magic Link", enabled: data.auth.magicLink },
              { label: "GitHub", enabled: data.auth.github },
              { label: "Passwords", enabled: data.auth.passwords },
              { label: "2FA", enabled: data.auth.twoFactor },
            ]).map(({ label, enabled }) => (
              <div
                key={label}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                  enabled ? "bg-status-success-muted text-status-success" : "bg-muted text-muted-foreground"
                }`}
              >
                {enabled ? <Check className="size-3" /> : <X className="size-3" />}
                {label}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            {[1,2,3,4,5].map((i) => <div key={i} className="h-6 w-20 bg-muted rounded animate-pulse" />)}
          </div>
        )}
      </div>

      {/* Feature flags */}
      <div className="squircle rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-2 border-b">
          <p className="text-xs text-muted-foreground">Feature Flags</p>
        </div>
        <div className="divide-y">
          {data ? (
            data.featureFlags.map(({ flag, enabled, label, description }) => (
              <div key={flag} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <div className={`inline-flex items-center gap-1 shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${
                  enabled ? "bg-status-success-muted text-status-success" : "bg-muted text-muted-foreground"
                }`}>
                  {enabled ? <Check className="size-3" /> : <X className="size-3" />}
                  {enabled ? "On" : "Off"}
                </div>
              </div>
            ))
          ) : (
            [1,2,3,4,5,6].map((i) => (
              <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                <div className="h-5 w-12 bg-muted rounded animate-pulse" />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
