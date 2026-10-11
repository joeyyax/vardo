"use client";

import { useEffect, useState } from "react";
import { Loader2, Recycle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import { formatBytes } from "@/lib/metrics/format";

type Run = {
  trigger: "deploy" | "nightly" | "disk" | "manual";
  finishedAt: string;
  skipped?: string;
  buildCacheBytes: number;
  danglingBytes: number;
  unusedImages: number;
  unusedBytes: number;
  containers: number;
  failures: number;
};

type State = {
  config: { enabled: boolean; minImageAgeHours: number };
  lastRun: Run | null;
  preview: { buildCacheBytes: number; unusedImages: number; unusedBytes: number } | null;
};

const ENDPOINT = "/api/v1/admin/maintenance/host-reclaim";

const TRIGGER_COPY: Record<Run["trigger"], string> = {
  deploy: "after deploys",
  nightly: "nightly",
  disk: "disk filling up",
  manual: "run by hand",
};

function describeRun(run: Run): string {
  const when = new Date(run.finishedAt).toLocaleString();
  if (run.skipped) return `${when}: ${run.skipped}`;
  const freed = run.buildCacheBytes + run.danglingBytes + run.unusedBytes;
  const images = run.unusedImages === 1 ? "1 unused image" : `${run.unusedImages} unused images`;
  return `${when} (${TRIGGER_COPY[run.trigger]}): freed ${formatBytes(freed)}, ${images}`;
}

async function fetchState(): Promise<State | null> {
  try {
    const res = await fetch(ENDPOINT);
    return res.ok ? ((await res.json()) as State) : null;
  } catch {
    return null;
  }
}

export function HostReclaimCard() {
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    const next = await fetchState();
    setFailed(next === null);
    if (next) setState(next);
  }

  useEffect(() => {
    async function first() {
      const next = await fetchState();
      setFailed(next === null);
      setState(next);
    }
    void first();
  }, []);

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch(ENDPOINT, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't run cleanup");
        return;
      }
      const run = data.run as Run;
      if (run.skipped) toast.error(`Cleanup skipped: ${run.skipped}`);
      else toast.success(`Freed ${formatBytes(run.buildCacheBytes + run.danglingBytes + run.unusedBytes)}`);
      await load();
    } catch {
      toast.error("Couldn't run cleanup");
    } finally {
      setRunning(false);
    }
  }

  async function handleToggle(enabled: boolean) {
    if (!state) return;
    setSaving(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...state.config, enabled }),
      });
      if (!res.ok) throw new Error();
      setState({ ...state, config: { ...state.config, enabled } });
    } catch {
      toast.error("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Recycle className="size-4" aria-hidden="true" />
          Automatic cleanup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Removes build cache, dangling images and images nothing uses: 10 minutes after deploys go quiet,
          nightly and before a disk alert. Images of each app&apos;s last three successful deploys stay for
          rollback. Volumes are never touched.
        </p>

        {state === null && !failed ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading...
          </div>
        ) : failed ? (
          <p className="text-sm text-status-warning">Couldn&apos;t load cleanup status.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Switch
                id="host-reclaim-enabled"
                checked={state!.config.enabled}
                disabled={saving}
                onCheckedChange={(checked) => void handleToggle(checked)}
              />
              <Label htmlFor="host-reclaim-enabled">Clean up automatically</Label>
            </div>
            <dl className="grid gap-1 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Last run</dt>
                <dd>{state!.lastRun ? describeRun(state!.lastRun) : "Not yet"}</dd>
              </div>
              {state!.preview && (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">Unused now</dt>
                  <dd className="tabular-nums">
                    {formatBytes(state!.preview.buildCacheBytes)} of build cache, {state!.preview.unusedImages} removable
                    images up to {formatBytes(state!.preview.unusedBytes)}
                  </dd>
                </div>
              )}
            </dl>
            <Button variant="outline" size="sm" disabled={running} onClick={() => void handleRun()}>
              {running ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {running ? "Cleaning up..." : "Clean up now"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
