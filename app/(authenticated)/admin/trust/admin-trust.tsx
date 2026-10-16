"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusMark, type StatusDotTone } from "@/components/ui/status-dot";
import { toast } from "@/lib/messenger";
import { cn } from "@/lib/utils";
import type { CheckState } from "@/lib/trust/types";
import type { TrustView } from "@/lib/trust/view";
import { CommitmentsCard } from "./commitments-card";
import { DocumentsCard } from "./documents-card";
import { SubprocessorsCard } from "./subprocessors-card";
import { VisibilityCard, type TrustPatch } from "./visibility-card";

const ENDPOINT = "/api/v1/admin/trust";
const PROBE_GUARD_ENDPOINT = "/api/v1/admin/probe-guard";

type Patch = TrustPatch;

const STATE_MARK: Record<CheckState, { tone: StatusDotTone; pending?: boolean; label: string }> = {
  passing: { tone: "good", label: "Passing" },
  partial: { tone: "warn", label: "Partial" },
  failing: { tone: "issue", label: "Failing" },
  unknown: { tone: "neutral", pending: true, label: "Unknown" },
};

function checkedAt(iso: string | null): string {
  if (!iso) return "Not checked";
  return `Checked ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function CheckRow({ state, title, evidence, aside }: { state: CheckState; title: string; evidence: string; aside?: React.ReactNode }) {
  const mark = STATE_MARK[state];
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 sm:flex-nowrap">
      <span className="mt-1.5"><StatusMark tone={mark.tone} pending={mark.pending} /></span>
      <div className="min-w-0 flex-1 basis-[calc(100%-1.5rem)] sm:basis-auto">
        <div className="text-sm font-medium"><span className="sr-only">{mark.label}: </span>{title}</div>
        <div className="text-sm text-muted-foreground">{evidence}</div>
      </div>
      {aside && <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 text-xs text-muted-foreground sm:pl-0">{aside}</div>}
    </li>
  );
}

function points(n: number): string {
  return String(Number(n.toFixed(1)));
}

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Sparkline({ days }: { days: TrustView["history"]["days"] }) {
  const w = 240;
  const h = 40;
  const lo = Math.min(...days.map((d) => d.score));
  const span = Math.max(1, Math.max(...days.map((d) => d.score)) - lo);
  const x = (i: number) => (days.length === 1 ? w / 2 : (i / (days.length - 1)) * w);
  const y = (score: number) => h - 3 - ((score - lo) / span) * (h - 6);
  const line = days.map((d, i) => `${x(i).toFixed(1)},${y(d.score).toFixed(1)}`).join(" ");
  const last = days[days.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full max-w-60 overflow-visible text-muted-foreground" role="img" aria-label={`Score over ${days.length} days, ${points(days[0].score)} to ${points(last.score)}`}>
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(days.length - 1)} cy={y(last.score)} r="2.5" className="fill-foreground" />
    </svg>
  );
}

export function AdminTrust() {
  const [view, setView] = useState<TrustView | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [savedContact, setSavedContact] = useState("");
  const [provider, setProvider] = useState("");
  const [region, setRegion] = useState("");

  const apply = useCallback((next: TrustView) => {
    setView(next);
    setName(next.name ?? "");
    setProvider(next.hostingOverride?.provider ?? "");
    setRegion(next.hostingOverride?.region ?? "");
  }, []);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(apply)
      .catch(() => toast.error("Couldn't load the trust center"));
    fetch(PROBE_GUARD_ENDPOINT)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { settings: { securityContact: string } }) => {
        setContact(data.settings.securityContact);
        setSavedContact(data.settings.securityContact);
      })
      .catch(() => toast.error("Couldn't load the security contact"));
  }, [apply]);

  const request = useCallback(async (method: "PATCH" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<TrustView | null> => {
    setBusy(true);
    try {
      const form = body instanceof FormData;
      const res = await fetch(url, {
        method,
        headers: form ? undefined : { "Content-Type": "application/json" },
        body: body ? (form ? body : JSON.stringify(body)) : undefined,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Couldn't save");
      apply(data as TrustView);
      return data as TrustView;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const save = useCallback(async (patch: Patch, undo?: Patch, message = "Saved") => {
    const saved = await request("PATCH", ENDPOINT, patch);
    if (!saved) return;
    toast.success(message, undo ? { action: { label: "Undo", onClick: () => void request("PATCH", ENDPOINT, undo) } } : undefined);
  }, [request]);

  if (!view) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading trust center</span>
      </div>
    );
  }

  const on = view.visibility !== "off";
  const hosting = view.hosting;
  const cert = hosting?.certification ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-72 space-y-1">
          <h2 className="type-h2">Trust center</h2>
          <p className="text-sm text-muted-foreground">A page for your clients on how this instance is hosted, backed up and secured. Your score and what&apos;s missing stay with admins.</p>
        </div>
        {on && (
          <div className="flex shrink-0 gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="/api/public/trust?preview=1" target="_blank" rel="noreferrer">Preview<ExternalLink className="size-3.5" /></a>
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void request("POST", `${ENDPOINT}/run`)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Run checks
            </Button>
          </div>
        )}
      </div>

      <VisibilityCard view={view} busy={busy} save={save} />

      {on && (
        <>
          <Card variant="surface" className="space-y-4 p-5">
            <div>
              <div className="text-xs font-medium text-muted-foreground">Your score <span className="font-normal">· only admins see this</span></div>
              <div className="type-h1 tabular-nums">
                {view.score.score} of {view.score.max}
                {view.score.bandLabel && <span className="text-muted-foreground"> · {view.score.bandLabel}</span>}
              </div>
              {view.score.unverified > 0 && (
                <p className="text-sm text-muted-foreground">{view.score.unverified} points not verified.</p>
              )}
            </div>
            <div className="relative pb-5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full rounded-full bg-success" style={{ width: `${(view.score.score / view.score.max) * 100}%` }} />
              </div>
              {view.score.bands.map((b) => (
                <div key={b.band} className="absolute top-0 text-xs text-muted-foreground" style={{ left: `${(b.at / view.score.max) * 100}%` }}>
                  <span className="absolute -top-0.5 left-0 h-2.5 w-px bg-border" aria-hidden />
                  <span className={cn("absolute left-0 top-3 -translate-x-1/2 whitespace-nowrap", b.band === view.score.band && "font-semibold text-foreground")}>{b.label}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card variant="surface" className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="type-h3">Next steps</h3>
              <p className="text-xs text-muted-foreground">{view.steps.length ? "Most points first" : view.reviews.length ? "" : "Nothing is failing."}</p>
            </div>
            {view.reviews.length > 0 && (
              <div className="mt-2">
                <div className="text-xs font-medium text-muted-foreground">To review before it&apos;s public</div>
                <ul className="divide-y">
                  {view.reviews.map((r) => (
                    <CheckRow
                      key={r.id}
                      state="unknown"
                      title={r.title}
                      evidence={r.detail}
                      aside={<Button asChild variant="outline" size="xs"><a href={r.href}>{r.action}</a></Button>}
                    />
                  ))}
                </ul>
              </div>
            )}
            {view.steps.length > 0 && (
              <ul className="mt-2 divide-y">
                {view.steps.map((s) => (
                  <CheckRow
                    key={s.id}
                    state={s.state}
                    title={s.fix}
                    evidence={s.evidence}
                    aside={
                      <>
                        <span>{s.effort}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 font-medium tabular-nums">+{points(s.gain)} points</span>
                        <Button asChild variant="outline" size="xs">
                          {s.href.startsWith("#") ? <a href={s.href}>{s.action}</a> : <Link href={s.href}>{s.action}</Link>}
                        </Button>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card id="about" variant="surface" className="space-y-4 py-5">
              <CardHeader><CardTitle>About you</CardTitle></CardHeader>
              <CardContent className="max-w-md space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="trust-name">Name</Label>
                  <Input
                    id="trust-name"
                    value={name}
                    placeholder="You or your business"
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => saveName()}
                  />
                  <p className="text-xs text-muted-foreground">Shown at the top of the page and used in the policies. Required to go public.</p>
                </div>
                <div className="space-y-2">
                <Label htmlFor="trust-contact">Security contact</Label>
                <Input
                  id="trust-contact"
                  type="email"
                  value={contact}
                  placeholder="security@example.com"
                  onChange={(e) => setContact(e.target.value)}
                  onBlur={() => void saveContact()}
                />
                <p className="text-xs text-muted-foreground">Where people report problems. Published at /.well-known/security.txt.</p>
                </div>
              </CardContent>
            </Card>

            <Card id="hosting" variant="surface" className="space-y-4 py-5">
              <CardHeader><CardTitle>Hosting</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <ul className="divide-y">
                  {hosting ? (
                    <CheckRow
                      state="passing"
                      title={[hosting.provider, hosting.region].filter(Boolean).join(" · ")}
                      evidence={hosting.source === "manual" ? "Set by you." : "Read from the server's cloud metadata."}
                    />
                  ) : (
                    <CheckRow state="unknown" title="Not detected" evidence="No Hetzner or AWS EC2 metadata answered. Set the provider below." />
                  )}
                  {cert && (
                    <CheckRow
                      state={cert.state}
                      title={`${cert.standard}${cert.number ? `, ${cert.number}` : ""}`}
                      evidence={cert.evidence}
                      aside={
                        <Button asChild variant="outline" size="xs">
                          <a href={cert.url} target="_blank" rel="noreferrer">View<ExternalLink className="size-3.5" /></a>
                        </Button>
                      }
                    />
                  )}
                </ul>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="trust-provider">Provider</Label>
                    <Input id="trust-provider" value={provider} placeholder="Provider name" onChange={(e) => setProvider(e.target.value)} onBlur={() => saveHosting()} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="trust-region">Region</Label>
                    <Input id="trust-region" value={region} placeholder="Location or region" onChange={(e) => setRegion(e.target.value)} onBlur={() => saveHosting()} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {view.hostingOverride ? "Overrides detection. Clear both fields to use the detected host." : "Fill in to override detection."}
                </p>
              </CardContent>
            </Card>
          </div>

          <CommitmentsCard commitments={view.commitments} busy={busy} call={request} />

          <SubprocessorsCard rows={view.subprocessors} busy={busy} call={request} />

          <DocumentsCard documents={view.documents} busy={busy} call={request} />

          <Card variant="surface" className="space-y-3 p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="type-h3">History</h3>
              <p className="text-xs text-muted-foreground">Last 30 days</p>
            </div>
            {view.history.days.length < 2 ? (
              <p className="text-sm text-muted-foreground">The chart shows once two days have results.</p>
            ) : (
              <div className="space-y-1">
                <Sparkline days={view.history.days} />
                <div className="flex max-w-60 justify-between text-xs text-muted-foreground tabular-nums">
                  <span>{shortDay(view.history.days[0].day)} · {points(view.history.days[0].score)}</span>
                  <span>{shortDay(view.history.days[view.history.days.length - 1].day)} · {points(view.history.days[view.history.days.length - 1].score)}</span>
                </div>
              </div>
            )}
            {view.history.changes.length > 0 && (
              <ul className="divide-y text-sm">
                {[...view.history.changes].reverse().map((c, i) => (
                  <li key={`${c.at}-${i}`} className="flex justify-between gap-3 py-2">
                    <span>{c.text}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{shortDay(c.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card variant="surface" className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="type-h3">All checks</h3>
              <p className="text-xs text-muted-foreground">
                {view.counts.passing} passing · {view.counts.partial} partial · {view.counts.failing} failing · {view.counts.unknown} unknown
              </p>
            </div>
            <ul className="mt-2 divide-y">
              {view.checks.map((c) => (
                <CheckRow key={c.id} state={c.state} title={c.title} evidence={c.evidence} aside={<><span className="tabular-nums">{points(c.earned)} of {c.weight}</span><span>{checkedAt(c.checkedAt)}</span></>} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );

  async function saveContact() {
    const next = contact.trim();
    if (next === savedContact) return;
    setBusy(true);
    try {
      const res = await fetch(PROBE_GUARD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityContact: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save");
      setSavedContact(next);
      toast.success("Saved");
      await request("POST", `${ENDPOINT}/run`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
      setContact(savedContact);
    } finally {
      setBusy(false);
    }
  }

  function saveName() {
    if (!view) return;
    const next = name.trim() || null;
    if (next === view.name) return;
    if (!next && view.visibility === "public") {
      toast.error("The public page needs a name");
      setName(view.name ?? "");
      return;
    }
    void save({ name: next }, { name: view.name });
  }

  function saveHosting() {
    if (!view) return;
    const next = provider.trim() ? { provider: provider.trim(), region: region.trim() } : null;
    const prev = view.hostingOverride;
    if (next?.provider === prev?.provider && next?.region === prev?.region) return;
    if (!next && !prev) return;
    void save({ hostingOverride: next }, { hostingOverride: prev });
  }
}
