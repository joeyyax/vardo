"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RangePicker } from "@/components/range-picker";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { vantageNames } from "@/lib/uptime/format";
import type { IntervalSec, MonitorSummary, VantageView } from "@/lib/uptime/types";

type CheckType = "http" | "tcp" | "tls";

const TYPES = [
  { value: "http", label: "HTTP" },
  { value: "tcp", label: "TCP port" },
  { value: "tls", label: "TLS certificate" },
] as const;

const INTERVALS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
] as const;

type Form = {
  type: CheckType;
  url: string;
  host: string;
  port: string;
  name: string;
  statusMin: string;
  statusMax: string;
  timeout: string;
  keyword: string;
  warnDays: string;
  interval: "30" | "60" | "300";
};

function initial(monitor?: MonitorSummary): Form {
  const c = monitor?.check;
  return {
    type: c?.type ?? "http",
    url: c?.type === "http" ? c.url : "https://",
    host: c && c.type !== "http" ? c.host : "",
    port: c && c.type !== "http" ? String(c.port) : "",
    name: monitor?.name ?? "",
    statusMin: c?.type === "http" ? String(c.expectedStatus.min) : "200",
    statusMax: c?.type === "http" ? String(c.expectedStatus.max) : "399",
    timeout: c?.type === "http" ? String(Math.round(c.timeoutMs / 1000)) : "10",
    keyword: c?.type === "http" ? (c.keyword ?? "") : "",
    warnDays: c?.type === "tls" ? String(c.warnDays) : "14",
    interval: String(monitor?.intervalSec ?? 60) as Form["interval"],
  };
}

/** Adds a monitor, or edits a manual one. */
export function MonitorSheet({
  open,
  onOpenChange,
  apiBase,
  vantages,
  monitor,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `/api/v1/organizations/<orgId>/uptime/monitors` */
  apiBase: string;
  vantages: VantageView[];
  monitor?: MonitorSummary;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Form>(() => initial(monitor));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Reset each time the sheet opens.
  const [seen, setSeen] = useState(open);
  if (seen !== open) {
    setSeen(open);
    if (open) setForm(initial(monitor));
  }

  function body() {
    const common = { name: form.name.trim() || undefined, intervalSec: Number(form.interval) as IntervalSec };
    if (form.type === "http") {
      return {
        ...common,
        type: "http",
        url: form.url.trim(),
        expectedStatus: { min: Number(form.statusMin), max: Number(form.statusMax) },
        timeoutMs: Math.round(Number(form.timeout) * 1000),
        keyword: monitor ? form.keyword.trim() || null : form.keyword.trim() || undefined,
      };
    }
    const target = { ...common, type: form.type, host: form.host.trim(), port: Number(form.port) || (form.type === "tls" ? 443 : undefined) };
    return form.type === "tls" ? { ...target, warnDays: Number(form.warnDays) } : target;
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(monitor ? `${apiBase}/${monitor.id}` : apiBase, {
        method: monitor ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Couldn't save the monitor");
        return;
      }
      toast.success(monitor ? "Monitor saved" : "Monitor added");
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error("Couldn't save the monitor");
    } finally {
      setSaving(false);
    }
  }

  const target = form.type === "http" ? form.url.trim().length > 8 : form.host.trim().length > 0 && (form.type === "tls" || Number(form.port) > 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{monitor ? "Edit monitor" : "Add monitor"}</SheetTitle>
          <SheetDescription>{monitor ? "Changes apply on the next check." : "Checks run on a schedule and alert when a target goes down."}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          {!monitor && (
            <div className="grid gap-2">
              <Label>Check</Label>
              <RangePicker options={TYPES} value={form.type} onChange={(v) => set("type", v)} label="Check type" />
            </div>
          )}

          {form.type === "http" ? (
            <div className="grid gap-2">
              <Label htmlFor="uptime-url">URL</Label>
              <Input id="uptime-url" value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/health" />
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="uptime-host">Host</Label>
                <Input id="uptime-host" value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="db.example.com" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="uptime-port">Port</Label>
                <Input id="uptime-port" inputMode="numeric" value={form.port} onChange={(e) => set("port", e.target.value)} placeholder={form.type === "tls" ? "443" : "5432"} />
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="uptime-name">Name</Label>
            <Input id="uptime-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Defaults to the target" />
          </div>

          {form.type === "http" && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="uptime-min">Status from</Label>
                  <Input id="uptime-min" inputMode="numeric" value={form.statusMin} onChange={(e) => set("statusMin", e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="uptime-max">Status to</Label>
                  <Input id="uptime-max" inputMode="numeric" value={form.statusMax} onChange={(e) => set("statusMax", e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="uptime-timeout">Timeout (s)</Label>
                  <Input id="uptime-timeout" inputMode="numeric" value={form.timeout} onChange={(e) => set("timeout", e.target.value)} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="uptime-keyword">Keyword (optional)</Label>
                <Input id="uptime-keyword" value={form.keyword} onChange={(e) => set("keyword", e.target.value)} placeholder="Text the page must contain" />
              </div>
            </>
          )}

          {form.type === "tls" && (
            <div className="grid gap-2">
              <Label htmlFor="uptime-warn">Warn when it expires within (days)</Label>
              <Input id="uptime-warn" inputMode="numeric" value={form.warnDays} onChange={(e) => set("warnDays", e.target.value)} />
            </div>
          )}

          <div className="grid gap-2">
            <Label>Interval</Label>
            <RangePicker options={INTERVALS} value={form.interval} onChange={(v) => set("interval", v)} label="Check interval" />
          </div>

          <p className="text-sm text-muted-foreground">Checked from {vantageNames(vantages)}.</p>
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !target}>
            {saving && <Loader2 className="animate-spin" />}
            {monitor ? "Save" : "Add monitor"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
