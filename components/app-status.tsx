"use client";

import { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { detectAppType } from "@/lib/ui/app-type";
import { formatUptime } from "@/lib/metrics/format";

export function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setText(formatUptime((Date.now() - new Date(since).getTime()) / 1000));
    const interval = setInterval(update, 1000);
    const id = requestAnimationFrame(update);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(id);
    };
  }, [since]);
  if (!text) return null;
  return <span className="tabular-nums">{text}</span>;
}

/** `startedAt` is the container's start time; no container means no uptime. */
export function StatusIndicator({
  status,
  startedAt,
  needsRedeploy,
}: {
  status: string;
  startedAt?: Date | null;
  needsRedeploy?: boolean;
}) {
  const isRunning = status === "active" || status === "running";

  // Restart can't clear this; only a deploy recreates the containers.
  if (isRunning && needsRedeploy) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-status-warning shrink-0">
        <AlertTriangle className="size-3.5" />
        Deploy needed
      </span>
    );
  }
  if (isRunning) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-status-success shrink-0">
        <span aria-hidden="true" className="size-2 rounded-full bg-status-success animate-pulse" />
        {startedAt ? <Uptime since={startedAt} /> : "Running"}
      </span>
    );
  }
  if (status === "missing") return (
    <span className="flex items-center gap-1.5 text-sm text-status-warning shrink-0">
      <AlertTriangle className="size-3.5" />
      No container
    </span>
  );
  if (status === "error") return (
    <span className="flex items-center gap-1.5 text-sm text-status-error shrink-0">
      <span aria-hidden="true" className="size-2 rounded-full bg-status-error" />
      Crashed
    </span>
  );
  if (status === "deploying") return <span className="text-sm text-status-info animate-pulse shrink-0">Deploying</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm text-status-neutral shrink-0">
      <span aria-hidden="true" className="size-2 rounded-full bg-status-neutral" />
      Stopped
    </span>
  );
}

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

import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <Badge variant="success">Active</Badge>;
    case "deploying":
      return (
        <Badge variant="info" className="animate-pulse">
          Deploying
        </Badge>
      );
    case "error":
      return <Badge variant="error">Crashed</Badge>;
    case "missing":
      return <Badge variant="warning">No container</Badge>;
    default:
      return <Badge variant="neutral">Stopped</Badge>;
  }
}

export function DeploymentStatusBadge({ status }: { status: "queued" | "running" | "success" | "failed" | "cancelled" | "rolled_back" | "superseded" }) {
  switch (status) {
    case "success":
      return <Badge variant="success">Success</Badge>;
    case "running":
      return <Badge variant="info" className="animate-pulse">Running</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    case "rolled_back":
      return <Badge variant="warning">Rolled back</Badge>;
    case "cancelled":
      return <Badge variant="neutral">Cancelled</Badge>;
    case "superseded":
      return <Badge variant="neutral">Superseded</Badge>;
    case "queued":
      return <Badge variant="info">Queued</Badge>;
    default:
      return <Badge variant="neutral">{status}</Badge>;
  }
}

export function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <Badge variant="success" className="shrink-0">
      <span
        aria-hidden="true"
        className="mr-1.5 size-1.5 rounded-full bg-status-success animate-pulse"
      />
      {label}
    </Badge>
  );
}

export function ChartCard({
  title,
  icon: Icon,
  value,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Latest reading, shown in the header. */
  value?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="size-4 text-muted-foreground shrink-0" />
          <h3 className="type-h4 truncate">{title}</h3>
        </div>
        {value !== undefined && (
          <div className="type-numeral text-sm tabular-nums shrink-0">{value}</div>
        )}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </div>
  );
}
