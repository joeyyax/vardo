"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { DefaultSource, ResourceDefault } from "@/lib/resources/defaults";

type Summary = {
  host: { cpus: number; memoryBytes: number; sizeClass: string } | null;
  defaults: { key: ResourceDefault["key"]; label: string; unit: ResourceDefault["unit"]; value: number | null; source: DefaultSource }[];
};

const SHORT_LABEL: Partial<Record<ResourceDefault["key"], string>> = {
  memoryCritical: "Critical memory",
  memoryStandard: "Standard memory",
  memoryDisposable: "Disposable memory",
  cpusStandard: "Standard CPUs",
  cpusDisposable: "Disposable CPUs",
  deployConcurrency: "Deploys at once",
};

function formatValue(unit: ResourceDefault["unit"], value: number | null): string {
  if (value === null) return "No cap";
  if (unit === "mb") return value >= 1024 && value % 256 === 0 ? `${value / 1024} GiB` : `${value} MB`;
  return String(value);
}

/** The host's size and the defaults it picked. Shows nothing when the request fails. */
export function ResourcesSummary() {
  const [data, setData] = useState<Summary | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/setup/resources", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Summary | null) => body && setData(body))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (!data) return null;
  const { host } = data;

  return (
    <Card className="w-full max-w-md rounded-2xl">
      <CardContent className="space-y-3 py-4 text-sm">
        <p>
          {host ? (
            <>
              <span className="font-medium">
                {host.cpus} CPUs · {(host.memoryBytes / 1024 ** 3).toFixed(1)} GiB memory
              </span>
              <span className="text-muted-foreground"> · {host.sizeClass} host</span>
            </>
          ) : (
            <span className="text-muted-foreground">Couldn&apos;t read the host&apos;s size, so Vardo uses fixed defaults.</span>
          )}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {data.defaults.map((d) => (
            <div key={d.key} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{SHORT_LABEL[d.key] ?? d.label}</dt>
              <dd className="tabular-nums">{formatValue(d.unit, d.value)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">You can change these later under System settings → Resources.</p>
      </CardContent>
    </Card>
  );
}
