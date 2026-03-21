"use client";

import { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { detectAppType } from "@/lib/ui/app-type";

// ---------------------------------------------------------------------------
// formatUptime + Uptime component
// ---------------------------------------------------------------------------

export function formatUptime(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(formatUptime(since));
    const interval = setInterval(() => setText(formatUptime(since)), 1000);
    return () => clearInterval(interval);
  }, [since]);
  if (!text) return null;
  return <span className="tabular-nums">{text}</span>;
}

// ---------------------------------------------------------------------------
// StatusIndicator — shows running/error/deploying/stopped with optional
// needsRedeploy warning state. Accepts either "active" or "running" for
// the running state (normalizes internally).
// ---------------------------------------------------------------------------

export function StatusIndicator({
  status,
  finishedAt,
  needsRedeploy,
}: {
  status: string;
  finishedAt?: Date | null;
  needsRedeploy?: boolean;
}) {
  const isRunning = status === "active" || status === "running";

  if (isRunning && needsRedeploy) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-status-warning shrink-0">
        <AlertTriangle className="size-3.5" />
        Restart
      </span>
    );
  }
  if (isRunning) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-status-success shrink-0">
        <span className="size-2 rounded-full bg-status-success animate-pulse" />
        {finishedAt ? <Uptime since={finishedAt} /> : "Running"}
      </span>
    );
  }
  if (status === "error") return <span className="text-sm text-status-error shrink-0">Error</span>;
  if (status === "deploying") return <span className="text-sm text-status-info animate-pulse shrink-0">Deploying</span>;
  return <span className="text-sm text-status-neutral shrink-0">Stopped</span>;
}

// ---------------------------------------------------------------------------
// AppIcon — shows detected type icon or a colored dot fallback
// ---------------------------------------------------------------------------

export function AppIcon({
  app,
  size = "md",
}: {
  app: {
    imageName?: string | null;
    gitUrl?: string | null;
    deployType?: string | null;
    name?: string | null;
    displayName?: string | null;
  };
  size?: "sm" | "md" | "lg";
}) {
  const { icon, color } = detectAppType(app);
  const sizeClass = size === "sm" ? "size-8" : size === "lg" ? "size-12" : "size-10";
  const iconSize = size === "sm" ? "size-5" : size === "lg" ? "size-8" : "size-6";
  const dotSize = size === "sm" ? "size-2" : size === "lg" ? "size-3" : "size-2.5";

  if (!icon) {
    return (
      <div
        className={`${sizeClass} shrink-0 rounded-md flex items-center justify-center`}
        style={{ backgroundColor: `${color}20` }}
      >
        <span className={`${dotSize} rounded-full`} style={{ backgroundColor: color }} />
      </div>
    );
  }

  return (
    <div
      className={`${sizeClass} shrink-0 rounded-md flex items-center justify-center`}
      style={{ backgroundColor: `${color}10` }}
    >
      <img src={icon} alt="" className={`${iconSize} opacity-70`} />
    </div>
  );
}
