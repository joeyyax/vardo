"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cacheNote, formatBytes } from "@/lib/uptime/format";
import type { MonitorDetail, MonitorSummary } from "@/lib/uptime/types";

const SOURCE_NOTE = {
  healthcheck: "from the app's healthcheck",
  image: "a known path for the app's image",
  probe: "found by probing common paths",
  homepage: "the homepage",
} as const;

export const HOMEPAGE_HINT = "Checking the homepage. A health endpoint like /healthz is lighter and skips caches.";

/** "Checking /healthz", or the homepage hint, for an automatic monitor. Manual monitors show their URL instead. */
export function CheckNote({ monitor }: { monitor: Pick<MonitorSummary, "source" | "healthPath" | "healthSource" | "privateHeader" | "check" | "cachedBy" | "state"> }) {
  if (monitor.state === "stopped") return <p className="text-xs text-muted-foreground">Not checked while the app is stopped.</p>;
  const note = [];
  if (monitor.cachedBy) note.push(<span key="cache" className="text-status-warning">{cacheNote(monitor.cachedBy)}</span>);
  if (monitor.source === "auto" && monitor.check.type === "http" && monitor.healthSource) {
    note.push(
      monitor.healthPath ? (
        <span key="path">
          Checking <code className="font-mono">{monitor.healthPath}</code> · {SOURCE_NOTE[monitor.healthSource]}
        </span>
      ) : (
        <span key="home">{HOMEPAGE_HINT}</span>
      ),
    );
  }
  if (monitor.privateHeader) note.push(<span key="private">Checked from this instance only: it uses a private header.</span>);
  if (note.length === 0) return null;
  return <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground [&>span]:max-w-full">{note}</p>;
}

export type HeaderRow = { name: string; value: string; stored: boolean };
export type HeaderDraft = { rows: HeaderRow[]; username: string; password: string; share: boolean; dirty: boolean };

export const draftOf = (monitor?: Pick<MonitorSummary, "headers" | "shareHeaders">): HeaderDraft => ({
  rows: (monitor?.headers ?? []).map((name) => ({ name, value: "", stored: true })),
  username: "",
  password: "",
  share: monitor?.shareHeaders ?? false,
  dirty: false,
});

/** The request body fields for a draft. Stored values are sent as names only so the server keeps them. */
export function headerFields(draft: HeaderDraft, includeShare: boolean) {
  const fields: Record<string, unknown> = {};
  if (draft.dirty) {
    fields.headers = draft.rows.filter((r) => r.name.trim()).map((r) => (r.stored ? { name: r.name } : { name: r.name.trim(), value: r.value }));
    if (draft.username && draft.password) fields.basicAuth = { username: draft.username, password: draft.password };
  }
  if (includeShare) fields.shareHeaders = draft.share;
  return fields;
}

/** Name and value rows for request headers. A stored value shows as set and is never read back. */
export function HeadersField({ draft, onChange, idPrefix }: { draft: HeaderDraft; onChange: (next: HeaderDraft) => void; idPrefix: string }) {
  const edit = (next: Partial<HeaderDraft>) => onChange({ ...draft, ...next, dirty: true });
  const setRow = (i: number, row: Partial<HeaderRow>) => edit({ rows: draft.rows.map((r, j) => (j === i ? { ...r, ...row } : r)) });
  const hasHeaders = draft.rows.length > 0 || (draft.username && draft.password);

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label>Request headers</Label>
        <Button type="button" variant="ghost" size="sm" onClick={() => edit({ rows: [...draft.rows, { name: "", value: "", stored: false }] })}>
          <Plus /> Add header
        </Button>
      </div>
      {draft.rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
          <Input
            aria-label="Header name"
            placeholder="X-Health-Token"
            value={row.name}
            disabled={row.stored}
            onChange={(e) => setRow(i, { name: e.target.value })}
          />
          {row.stored ? (
            <div className="flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm text-muted-foreground">
              <span>•••• set</span>
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setRow(i, { stored: false, value: "" })}>
                Replace
              </button>
            </div>
          ) : (
            <Input aria-label="Header value" type="password" autoComplete="off" placeholder="Value" value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} />
          )}
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${row.name || "header"}`} onClick={() => edit({ rows: draft.rows.filter((_, j) => j !== i) })}>
            <X />
          </Button>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2">
        <Input
          id={`${idPrefix}-user`}
          aria-label="Basic auth username"
          autoComplete="off"
          placeholder="Basic auth user"
          value={draft.username}
          onChange={(e) => edit({ username: e.target.value })}
        />
        <Input
          id={`${idPrefix}-pass`}
          aria-label="Basic auth password"
          type="password"
          autoComplete="off"
          placeholder="Password"
          value={draft.password}
          onChange={(e) => edit({ password: e.target.value })}
        />
      </div>
      {hasHeaders && (
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <Label htmlFor={`${idPrefix}-share`}>Let linked instances use these headers</Label>
            <p className="text-xs text-muted-foreground">Off: only this instance checks the monitor.</p>
          </div>
          <Switch id={`${idPrefix}-share`} checked={draft.share} onCheckedChange={(share) => onChange({ ...draft, share })} />
        </div>
      )}
    </div>
  );
}

/** The question for a monitor that answers below 500 but not 2xx. */
export function ReviewCard({ monitor, apiBase, canManage, onAnswered }: { monitor: MonitorSummary; apiBase: string; canManage: boolean; onAnswered: () => void }) {
  const review = monitor.review;
  const [mode, setMode] = useState<"status" | "path" | "header" | null>(null);
  const [path, setPath] = useState("/healthz");
  const [method, setMethod] = useState<"GET" | "HEAD" | "POST">("GET");
  const [upStatus, setUpStatus] = useState("");
  const [draft, setDraft] = useState<HeaderDraft>(() => draftOf());
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  if (!review) return null;

  const detectBase = apiBase.replace(/\/monitors$/, "/detect");
  const what = review.reason === "login" ? `${monitor.name} redirects to a login page` : `${monitor.name} answers ${review.status}`;

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/${monitor.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error || "Couldn't save the answer");
        return;
      }
      toast.success(done);
      setMode(null);
      onAnswered();
    } catch {
      toast.error("Couldn't save the answer");
    } finally {
      setBusy(false);
    }
  }

  async function detect() {
    setBusy(true);
    try {
      const base = monitor.check.type === "http" ? monitor.check.url.replace(monitor.healthPath ?? "", "") : "";
      const res = await fetch(detectBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: base }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(data.error || "Couldn't look for a health path");
      else if (data.detected?.found) {
        setPath(data.detected.path);
        setFound(data.detected.path);
      } else toast.info("No health path found. Enter one to try.");
    } catch {
      toast.error("Couldn't look for a health path");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Callout variant="warning" label="Needs review" className="flex-wrap">
      <div className="grid gap-3">
        <p>
          {what}
          {review.reason === "status" ? ` at ${monitor.healthPath ?? "/"}` : ""}. What should count as up?
          <span className="text-muted-foreground"> Alerts and uptime wait for your answer.</span>
        </p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => send({ kind: "status", status: review.reason === "login" ? 200 : review.status }, "Saved")}>
              {review.reason === "login" ? "The redirect is expected" : `${review.status} is expected`}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(mode === "path" ? null : "path")}>
              Use a health path
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(mode === "header" ? null : "header")}>
              Add a header
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => send({ kind: "skip" }, "Domain no longer monitored")}>
              Don&apos;t monitor this domain
            </Button>
          </div>
        )}
        {mode === "path" && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`review-${monitor.id}-method`} className="text-xs text-muted-foreground">
                Method
              </Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger id={`review-${monitor.id}-method`} className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="HEAD">HEAD</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-40 flex-1 gap-1.5 sm:max-w-56 sm:flex-none">
              <Label htmlFor={`review-${monitor.id}-path`} className="text-xs text-muted-foreground">
                Path
              </Label>
              <Input id={`review-${monitor.id}-path`} className="font-mono" value={path} onChange={(e) => setPath(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`review-${monitor.id}-status`} className="text-xs text-muted-foreground">
                Up when it answers
              </Label>
              <Input id={`review-${monitor.id}-status`} className="w-28" inputMode="numeric" placeholder="Any 2xx" value={upStatus} onChange={(e) => setUpStatus(e.target.value.replace(/\D/g, "").slice(0, 3))} />
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={detect}>
              {busy && <Loader2 className="animate-spin" />} Detect
            </Button>
            <Button
              size="sm"
              disabled={busy || !path.startsWith("/")}
              onClick={() => send({ kind: "path", path, ...(method !== "GET" ? { method } : {}), ...(upStatus ? { status: Number(upStatus) } : {}) }, `Checking ${method} ${path}`)}
            >
              Use {method === "GET" ? "" : `${method} `}
              {path}
            </Button>
            {found && <span className="text-xs text-muted-foreground">Found {found}.</span>}
          </div>
        )}
        {mode === "header" && (
          <div className="grid gap-3">
            <HeadersField draft={draft} onChange={setDraft} idPrefix={`review-${monitor.id}`} />
            <div>
              <Button size="sm" disabled={busy || !draft.dirty} onClick={() => send({ kind: "headers", ...headerFields(draft, true) }, "Headers saved. Checking again.")}>
                Save headers
              </Button>
            </div>
          </div>
        )}
      </div>
    </Callout>
  );
}

/** Says each check loads a heavy or slow page, and offers the lighter path Vardo knows of. */
export function HeavyNoticeCard({ monitor, apiBase, canManage, onChanged }: { monitor: MonitorDetail; apiBase: string; canManage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const heavy = monitor.heavy;
  if (!heavy || monitor.check.type !== "http") return null;
  const check = monitor.check;
  const page = new URL(check.url).pathname.replace(/\/+$/, "") === "" ? "homepage" : "page";
  const what =
    heavy.heavy && heavy.bytes !== null ? `Each check loads the whole ${formatBytes(heavy.bytes, heavy.atLeast)} ${page}` : `Each check waits about ${heavy.medianMs} ms for the ${page}`;
  const offer = heavy.offer;

  async function call(url: string, method: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error || "Couldn't save");
        return;
      }
      toast.success(done);
      onChanged();
    } catch {
      toast.error("Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  function switchToOffer() {
    if (!offer) return;
    if (monitor.source === "auto") return call(`${apiBase}/${monitor.id}/review`, "POST", { kind: "path", path: offer.path }, `Checking ${offer.path}`);
    return call(`${apiBase}/${monitor.id}`, "PATCH", { url: `${new URL(check.url).origin}${offer.path}` }, `Checking ${offer.path}`);
  }

  return (
    <Callout variant="info" label="Heavy check" className="flex-wrap">
      <div className="grid gap-3">
        <p>
          {what}. That&apos;s fine if you meant it, but a small, fast, uncached health endpoint makes a better check.
          {offer && (
            <span className="text-muted-foreground">
              {" "}
              {offer.source === "healthcheck" ? "The app's container healthcheck uses" : "Detection found"} <code className="font-mono">{offer.path}</code>.
            </span>
          )}
        </p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {offer && (
              <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={switchToOffer}>
                Check {offer.path} instead
              </Button>
            )}
            <Button size="sm" variant="ghost" className="w-full sm:w-auto" disabled={busy} onClick={() => call(`${apiBase}/${monitor.id}`, "PATCH", { heavyNoticeDismissed: true }, "Notice dismissed")}>
              Keep checking this {page}
            </Button>
          </div>
        )}
      </div>
    </Callout>
  );
}
