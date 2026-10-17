"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RangePicker } from "@/components/range-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { vantageNames } from "@/lib/uptime/format";
import { HOMEPAGE_HINT, HeadersField, draftOf, headerFields, type HeaderDraft } from "./health-parts";
import type { AutoOverrides, IntervalSec, MonitorSummary, VantageView } from "@/lib/uptime/types";

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

/** An app's domain a new check can be linked to. */
export type CheckLink = { appId: string; domains: { id: string; host: string }[]; domainId?: string };

type Form = {
  type: CheckType;
  url: string;
  /** An automatic monitor's path under its domain. */
  path: string;
  host: string;
  port: string;
  name: string;
  statusMin: string;
  statusMax: string;
  timeout: string;
  keyword: string;
  warnDays: string;
  interval: "30" | "60" | "300";
  domainId: string;
};

function initial(monitor?: MonitorSummary, link?: CheckLink): Form {
  const c = monitor?.check;
  const domain = link?.domains.find((d) => d.id === link.domainId) ?? link?.domains[0];
  return {
    type: c?.type ?? "http",
    url: c?.type === "http" ? c.url : domain ? `https://${domain.host}` : "https://",
    path: monitor?.healthPath ?? "",
    host: c && c.type !== "http" ? c.host : (domain?.host ?? ""),
    port: c && c.type !== "http" ? String(c.port) : "",
    name: monitor?.name ?? "",
    statusMin: c?.type === "http" ? String(c.expectedStatus.min) : "200",
    statusMax: c?.type === "http" ? String(c.expectedStatus.max) : "399",
    timeout: c?.type === "http" ? String(Math.round(c.timeoutMs / 1000)) : "10",
    keyword: c?.type === "http" ? (c.keyword ?? "") : "",
    warnDays: c?.type === "tls" ? String(c.warnDays) : "14",
    interval: String(monitor?.intervalSec ?? 60) as Form["interval"],
    domainId: domain?.id ?? "",
  };
}

/** The part of an automatic monitor's URL the operator can't change: scheme and host, plus any path prefix. */
function baseOf(monitor: MonitorSummary): string {
  if (monitor.check.type !== "http") return "";
  const { url } = monitor.check;
  return monitor.healthPath && url.endsWith(monitor.healthPath) ? url.slice(0, -monitor.healthPath.length) : url;
}

function Edited({ show }: { show: boolean }) {
  return show ? (
    <Chip tone="info" caps={false}>
      Edited
    </Chip>
  ) : null;
}

function Field({ id, label, edited, children }: { id: string; label: string; edited?: boolean; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="flex items-center gap-2">
        {label} <Edited show={!!edited} />
      </Label>
      {children}
    </div>
  );
}

/**
 * Adds a monitor, or edits one. An automatic monitor's host stays on its domain: what's changed is stored as an edit that
 * auto-sync and detection leave alone, until the operator resets it. With `link`, a new check belongs to the app and domain.
 */
export function MonitorSheet({
  open,
  onOpenChange,
  apiBase,
  vantages,
  monitor,
  link,
  checkedFrom,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `/api/v1/organizations/<orgId>/uptime/monitors` */
  apiBase: string;
  vantages: VantageView[];
  monitor?: MonitorSummary;
  link?: CheckLink;
  /** Names the vantage points when the caller has no list of them. */
  checkedFrom?: string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Form>(() => initial(monitor, link));
  const [saving, setSaving] = useState(false);
  const [headers, setHeaders] = useState<HeaderDraft>(() => draftOf(monitor));
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<string | null>(null);
  const auto = monitor?.source === "auto";
  const edits: AutoOverrides = (auto && monitor?.overrides) || {};
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Reset each time the sheet opens.
  const [seen, setSeen] = useState(open);
  if (seen !== open) {
    setSeen(open);
    if (open) {
      setForm(initial(monitor, link));
      setHeaders(draftOf(monitor));
      setDetected(null);
    }
  }

  const domainHost = (id: string) => link?.domains.find((d) => d.id === id)?.host ?? "";
  function chooseDomain(id: string) {
    const host = domainHost(id);
    setForm((f) => ({ ...f, domainId: id, host: f.type === "http" ? f.host : host, url: f.type === "http" ? `https://${host}` : f.url }));
  }

  /** Looks for a health endpoint at the URL typed in and points the URL at it. */
  async function detect() {
    setDetecting(true);
    setDetected(null);
    try {
      const rows = headers.rows.filter((r) => r.name.trim() && r.value && !r.stored).map((r) => ({ name: r.name.trim(), value: r.value }));
      const res = await fetch(apiBase.replace(/\/monitors$/, "/detect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.url.trim(), ...(rows.length ? { headers: rows } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Couldn't look for a health endpoint");
        return;
      }
      const found = data.detected;
      if (!found.reachable) setDetected("The site didn't answer. Check the address.");
      else if (found.found) {
        set("url", found.url);
        setDetected(`Found ${found.path}. The URL now points at it.`);
      } else setDetected(found.review ? `The homepage answers ${found.review.status}. Add a header, or enter a health path.` : "No health endpoint found. The homepage will be checked.");
    } catch {
      toast.error("Couldn't look for a health endpoint");
    } finally {
      setDetecting(false);
    }
  }

  /** Only what differs from the monitor today, so an edit overrides one field and leaves the rest automatic. */
  function autoBody() {
    const start = initial(monitor);
    const out: Record<string, unknown> = {};
    if (form.name.trim() !== start.name) out.name = form.name.trim();
    if (form.path.trim() !== start.path) out.path = form.path.trim();
    if (form.statusMin !== start.statusMin || form.statusMax !== start.statusMax) out.expectedStatus = { min: Number(form.statusMin), max: Number(form.statusMax) };
    if (form.keyword.trim() !== start.keyword) out.keyword = form.keyword.trim() || null;
    if (form.timeout !== start.timeout) out.timeoutMs = Math.round(Number(form.timeout) * 1000);
    if (form.interval !== start.interval) out.intervalSec = Number(form.interval);
    return { ...out, ...headerFields(headers, true) };
  }

  function body() {
    if (auto) return autoBody();
    const common = { name: form.name.trim() || undefined, intervalSec: Number(form.interval) as IntervalSec };
    const linked = !monitor && link ? { appId: link.appId, ...(form.domainId ? { domainId: form.domainId } : {}) } : {};
    if (form.type === "http") {
      return {
        ...common,
        ...linked,
        ...headerFields(headers, true),
        type: "http",
        url: form.url.trim(),
        expectedStatus: { min: Number(form.statusMin), max: Number(form.statusMax) },
        timeoutMs: Math.round(Number(form.timeout) * 1000),
        keyword: monitor ? form.keyword.trim() || null : form.keyword.trim() || undefined,
      };
    }
    const target = { ...common, ...linked, type: form.type, host: form.host.trim(), port: Number(form.port) || (form.type === "tls" ? 443 : undefined) };
    return form.type === "tls" ? { ...target, warnDays: Number(form.warnDays) } : target;
  }

  async function send(payload: unknown, done: string) {
    setSaving(true);
    try {
      const res = await fetch(monitor ? `${apiBase}/${monitor.id}` : apiBase, {
        method: monitor ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Couldn't save the monitor");
        return;
      }
      toast.success(done);
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error("Couldn't save the monitor");
    } finally {
      setSaving(false);
    }
  }

  const save = () => send(body(), monitor ? "Monitor saved" : link ? "Check added" : "Monitor added");
  const reset = () => send({ resetOverrides: true }, "Back to automatic");

  const target = auto || (form.type === "http" ? form.url.trim().length > 8 : form.host.trim().length > 0 && (form.type === "tls" || Number(form.port) > 0));
  const hasEdits = auto && Object.keys(edits).length > 0;
  const title = monitor ? "Edit monitor" : link ? "Add check" : "Add monitor";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {auto
              ? "The host follows the domain. What you change here stays until you reset it."
              : monitor
                ? "Changes apply on the next check."
                : link
                  ? "Another check on this app: a second path, a keyword, the certificate or a port."
                  : "Checks run on a schedule and alert when a target goes down."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          {!monitor && link && link.domains.length > 1 && (
            <div className="grid gap-2">
              <Label htmlFor="uptime-domain">Domain</Label>
              <Select value={form.domainId} onValueChange={chooseDomain}>
                <SelectTrigger id="uptime-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {link.domains.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.host}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!monitor && (
            <div className="grid gap-2">
              <Label>Check</Label>
              <RangePicker options={TYPES} value={form.type} onChange={(v) => set("type", v)} label="Check type" />
            </div>
          )}

          {auto ? (
            <Field id="uptime-path" label="Path" edited={edits.path !== undefined}>
              <div className="flex items-center gap-2">
                <span className="max-w-[55%] truncate font-mono text-xs text-muted-foreground" title={baseOf(monitor!)}>
                  {baseOf(monitor!)}
                </span>
                <Input id="uptime-path" className="font-mono" value={form.path} onChange={(e) => set("path", e.target.value)} placeholder="/healthz, or empty for the homepage" />
              </div>
            </Field>
          ) : form.type === "http" ? (
            <div className="grid gap-2">
              <Label htmlFor="uptime-url">URL</Label>
              <div className="flex gap-2">
                <Input id="uptime-url" value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/health" />
                {!monitor && (
                  <Button type="button" variant="outline" disabled={detecting || form.url.trim().length < 9} onClick={detect}>
                    {detecting && <Loader2 className="animate-spin" />} Detect
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{detected ?? HOMEPAGE_HINT}</p>
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

          <Field id="uptime-name" label="Name" edited={edits.name !== undefined}>
            <Input id="uptime-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Defaults to the target" />
          </Field>

          {(auto || form.type === "http") && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field id="uptime-min" label="Status from" edited={edits.expectedStatus !== undefined}>
                  <Input id="uptime-min" inputMode="numeric" value={form.statusMin} onChange={(e) => set("statusMin", e.target.value)} />
                </Field>
                <Field id="uptime-max" label="Status to" edited={edits.expectedStatus !== undefined}>
                  <Input id="uptime-max" inputMode="numeric" value={form.statusMax} onChange={(e) => set("statusMax", e.target.value)} />
                </Field>
                <Field id="uptime-timeout" label="Timeout (s)" edited={edits.timeoutMs !== undefined}>
                  <Input id="uptime-timeout" inputMode="numeric" value={form.timeout} onChange={(e) => set("timeout", e.target.value)} />
                </Field>
              </div>
              <Field id="uptime-keyword" label="Keyword (optional)" edited={edits.keyword !== undefined}>
                <Input id="uptime-keyword" value={form.keyword} onChange={(e) => set("keyword", e.target.value)} placeholder="Text the page must contain" />
              </Field>
              <HeadersField draft={headers} onChange={setHeaders} idPrefix="uptime-headers" />
            </>
          )}

          {!auto && form.type === "tls" && (
            <div className="grid gap-2">
              <Label htmlFor="uptime-warn">Warn when it expires within (days)</Label>
              <Input id="uptime-warn" inputMode="numeric" value={form.warnDays} onChange={(e) => set("warnDays", e.target.value)} />
            </div>
          )}

          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              Interval <Edited show={edits.intervalSec !== undefined} />
            </Label>
            <RangePicker options={INTERVALS} value={form.interval} onChange={(v) => set("interval", v)} label="Check interval" />
          </div>

          <p className="text-sm text-muted-foreground">Checked from {checkedFrom ?? vantageNames(vantages)}.</p>
        </div>

        <SheetFooter className="flex-row items-center justify-between gap-2">
          <div>
            {hasEdits && (
              <Button variant="ghost" onClick={reset} disabled={saving}>
                Reset to automatic
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !target}>
              {saving && <Loader2 className="animate-spin" />}
              {monitor ? "Save" : link ? "Add check" : "Add monitor"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
