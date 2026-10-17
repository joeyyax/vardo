"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import type { AppUptime, ContainerHealth } from "@/lib/uptime/types";
import { CheckNote, ReviewCard } from "./health-parts";

type Data = AppUptime & { container: ContainerHealth };

const statusText = (m: AppUptime["monitors"][number]) => {
  if (m.check.type !== "http") return "";
  const { min, max } = m.check.expectedStatus;
  return min === 100 && max === 499 ? "Any response below 500" : min === max ? `${min}` : `${min} to ${max}`;
};

/** The uptime check beside the container healthcheck, in the app's health settings. */
export function AppHealthSection({ orgId, appId, canManage, onRedeploy }: { orgId: string; appId: string; canManage: boolean; onRedeploy?: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/uptime/apps/${appId}`);
      if (res.ok) setData(await res.json());
    } catch {
      // Keep what's shown.
    }
  }, [orgId, appId]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  async function adopt() {
    setAdding(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/uptime/apps/${appId}/container-healthcheck`, { method: "POST" });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error || "Couldn't add the healthcheck");
        return;
      }
      toast.success("Healthcheck added. It takes effect on the next deploy.");
      onRedeploy?.();
      await load();
    } finally {
      setAdding(false);
    }
  }

  if (!data || data.monitors.length === 0) return null;
  const http = data.monitors.filter((m) => m.source === "auto" && m.check.type === "http" && !m.preview);
  if (http.length === 0 && !data.container.hasHealthcheck) return null;

  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">Health</h3>
        <p className="text-xs text-muted-foreground">What Vardo checks to know this app is up.</p>
      </div>

      <dl className="grid gap-2 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">Container healthcheck</dt>
          <dd>{data.container.hasHealthcheck ? (data.container.path ? <code className="font-mono">{data.container.path}</code> : "Set") : "None"}</dd>
        </div>
        {http.map((m) => (
          <div key={m.id} className="grid gap-1">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="min-w-0 truncate text-muted-foreground">
                Uptime check ·{" "}
                <Link href={`/uptime/${m.id}`} className="hover:underline">
                  {m.name}
                </Link>
              </dt>
              <dd className="text-right">
                {m.healthPath ? <code className="font-mono">{m.healthPath}</code> : m.healthSource ? "Homepage" : "Not detected yet"} · {statusText(m)}
              </dd>
            </div>
            <CheckNote monitor={m} />
          </div>
        ))}
      </dl>

      {data.reviews.map((m) => (
        <ReviewCard key={m.id} monitor={m} apiBase={`/api/v1/organizations/${orgId}/uptime/monitors`} canManage={canManage} onAnswered={load} />
      ))}

      {canManage && data.container.offerPath && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            The container has no healthcheck. Use <code className="font-mono">{data.container.offerPath}</code> as its healthcheck too, so Docker and Vardo watch the same path.
          </p>
          <Button size="sm" variant="outline" disabled={adding} onClick={adopt}>
            Use {data.container.offerPath}
          </Button>
        </div>
      )}
    </div>
  );
}
