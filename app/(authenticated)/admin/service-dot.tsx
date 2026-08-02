"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RelativeTime } from "@/components/relative-time";
import { toast } from "@/lib/messenger";
import {
  formatDuration,
  formatLatency,
  serviceDotColor,
  serviceStatusTone,
  serviceStatusWord,
} from "@/lib/ui/service-health";
import type { ServiceStatus } from "@/lib/config/health";

type ServiceDotProps = {
  service: ServiceStatus;
  onChecked: (status: ServiceStatus) => void;
};

/** A service's dot, plus everything needed to act on a red one. */
export function ServiceDot({ service, onChecked }: ServiceDotProps) {
  const [checking, setChecking] = useState(false);

  async function checkAgain() {
    setChecking(true);
    try {
      const res = await fetch(`/api/v1/admin/health/${encodeURIComponent(service.name)}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.service) throw new Error(data.error || "Check failed");

      const next = data.service as ServiceStatus;
      onChecked(next);
      if (next.status === "healthy") toast.success(`${next.name} is healthy`);
      else toast.error(`${next.name} is still down`, { description: next.error });
    } catch {
      toast.error(`Could not check ${service.name}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 -mx-1 text-left transition-colors hover:bg-accent cursor-pointer"
          aria-label={`${service.name}: ${serviceStatusWord(service.status)}`}
        >
          <span className={`size-1.5 rounded-full shrink-0 ${serviceDotColor(service.status)}`} />
          <span className="text-xs text-muted-foreground">{service.name}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{service.name}</p>
          <span className={`text-xs ${serviceStatusTone(service.status)}`}>
            {serviceStatusWord(service.status)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{service.description}</p>

        {service.error && (
          <p className="mt-3 rounded-md bg-muted px-2.5 py-2 font-mono text-xs break-words text-foreground">
            {service.error}
          </p>
        )}

        <dl className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Last checked</dt>
            <dd><RelativeTime date={service.checkedAt} /></dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Latency</dt>
            <dd className="tabular-nums">{formatLatency(service.latencyMs)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Timeout</dt>
            <dd className="tabular-nums">{formatDuration(service.timeoutMs)}</dd>
          </div>
        </dl>

        <div className="mt-3 flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={checkAgain} disabled={checking}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check again
          </Button>
          {service.logsHref && (
            <Button size="xs" variant="ghost" asChild>
              <Link href={service.logsHref}>
                <ScrollText />
                Logs
              </Link>
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
