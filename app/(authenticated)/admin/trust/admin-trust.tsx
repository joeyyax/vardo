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
import { LEVEL_LABELS, type CheckState } from "@/lib/trust/types";
import type { TrustView } from "@/lib/trust/view";

const ENDPOINT = "/api/v1/admin/trust";

type Patch = {
  visibility?: TrustView["visibility"];
  securityContact?: string;
  hostingOverride?: { provider: string; region: string } | null;
};

const STATE_MARK: Record<CheckState, { tone: StatusDotTone; pending?: boolean; label: string }> = {
  passing: { tone: "good", label: "Passing" },
  partial: { tone: "warn", label: "Partial" },
  failing: { tone: "issue", label: "Failing" },
  unknown: { tone: "neutral", pending: true, label: "Unknown" },
};

const LEVEL_DESCRIPTIONS = {
  basic: "Contact listed, HTTPS on every domain",
  good: "Backups, updates, sign-in and probe guard",
  better: "Restore tests and disk encryption",
  great: "Provider certification covers your location",
} as const;

const VISIBILITY_OPTIONS = [
  { value: "off", label: "Off", hint: "No checks run." },
  { value: "private", label: "Private", hint: "Vardo runs the checks. Only admins see the results." },
] as const;

function checkedAt(iso: string | null): string {
  if (!iso) return "Not checked";
  return `Checked ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function CheckRow({ state, title, evidence, aside }: { state: CheckState; title: string; evidence: string; aside?: React.ReactNode }) {
  const mark = STATE_MARK[state];
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="mt-1.5"><StatusMark tone={mark.tone} pending={mark.pending} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium"><span className="sr-only">{mark.label}: </span>{title}</div>
        <div className="text-sm text-muted-foreground">{evidence}</div>
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{aside}</div>}
    </li>
  );
}

function levelSummary(view: TrustView): string {
  const next = view.levels.find((l) => !l.complete);
  if (!next) return "Every check passes.";
  const open = view.checks.filter((c) => c.level === next.level && c.state !== "passing");
  const unknown = open.filter((c) => c.state === "unknown").length;
  const failing = open.length - unknown;
  const parts = [
    failing ? `${failing} ${failing === 1 ? "check" : "checks"} not passing` : "",
    unknown ? `${unknown} Vardo can't verify` : "",
  ].filter(Boolean);
  return `${LEVEL_LABELS[next.level]} needs ${open.length} more: ${parts.join(", ")}.`;
}

export function AdminTrust() {
  const [view, setView] = useState<TrustView | null>(null);
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState("");
  const [provider, setProvider] = useState("");
  const [region, setRegion] = useState("");

  const apply = useCallback((next: TrustView) => {
    setView(next);
    setContact(next.securityContact);
    setProvider(next.hostingOverride?.provider ?? "");
    setRegion(next.hostingOverride?.region ?? "");
  }, []);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(apply)
      .catch(() => toast.error("Couldn't load the trust center"));
  }, [apply]);

  const request = useCallback(async (method: "PATCH" | "POST", url: string, body?: Patch): Promise<TrustView | null> => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
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
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-h2">Trust center</h2>
          <p className="text-sm text-muted-foreground">Checks this instance against four levels and lists what&apos;s missing. Admins only.</p>
        </div>
        {on && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void request("POST", `${ENDPOINT}/run`)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Run checks
          </Button>
        )}
      </div>

      <Card variant="surface" className="space-y-3 p-4">
        <div role="radiogroup" aria-label="Trust center visibility" className="grid gap-2 sm:grid-cols-2">
          {VISIBILITY_OPTIONS.map((opt) => {
            const selected = view.visibility === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy}
                onClick={() => {
                  if (selected) return;
                  const previous = view.visibility;
                  void save({ visibility: opt.value }, { visibility: previous }, `Trust center ${opt.label.toLowerCase()}`);
                }}
                className={cn(
                  "squircle rounded-md border p-3 text-left transition-colors disabled:opacity-60",
                  selected ? "border-primary bg-accent" : "hover:bg-muted",
                )}
              >
                <span className="block text-sm font-semibold">{opt.label}</span>
                <span className="block text-sm text-muted-foreground">{opt.hint}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Not hosting work for others? Leave it off, or use Private to audit this instance.</p>
      </Card>

      {on && (
        <>
          <Card variant="surface" className="space-y-4 p-5">
            <div>
              <div className="text-xs font-medium text-muted-foreground">Your level <span className="font-normal">· only admins see this</span></div>
              <div className="type-h1">{view.level ? LEVEL_LABELS[view.level] : "Not yet Basic"}</div>
              <p className="text-sm text-muted-foreground">{levelSummary(view)}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              {view.levels.map((l) => {
                const current = view.level === l.level;
                return (
                  <div key={l.level} className="space-y-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className={cn("h-full rounded-full", l.complete ? "bg-success" : "bg-muted-foreground/45")} style={{ width: `${(l.passing / l.total) * 100}%` }} />
                    </div>
                    <div className={cn("flex justify-between text-sm", current ? "font-semibold" : "font-medium")}>
                      <span>{LEVEL_LABELS[l.level]}</span>
                      <span className="text-muted-foreground tabular-nums">{l.passing}/{l.total}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{LEVEL_DESCRIPTIONS[l.level]}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card variant="surface" className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="type-h3">Next steps</h3>
              <p className="text-xs text-muted-foreground">{view.steps.length ? "In level order" : "Nothing is failing."}</p>
            </div>
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
                        <span className="rounded-full bg-muted px-2 py-0.5 font-medium">{LEVEL_LABELS[s.level]}</span>
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
              <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
              <CardContent className="max-w-md space-y-2">
                <Label htmlFor="trust-contact">Security contact</Label>
                <Input
                  id="trust-contact"
                  type="email"
                  value={contact}
                  placeholder="security@example.com"
                  onChange={(e) => setContact(e.target.value)}
                  onBlur={() => {
                    if (contact.trim() === view.securityContact) return;
                    void save({ securityContact: contact.trim() });
                  }}
                />
                <p className="text-xs text-muted-foreground">Where people report problems.</p>
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
                    <Input id="trust-provider" value={provider} placeholder="Hetzner Online" onChange={(e) => setProvider(e.target.value)} onBlur={() => saveHosting()} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="trust-region">Region</Label>
                    <Input id="trust-region" value={region} placeholder="Hillsboro" onChange={(e) => setRegion(e.target.value)} onBlur={() => saveHosting()} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {view.hostingOverride ? "Overrides detection. Clear both fields to use the detected host." : "Fill in to override detection."}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card variant="surface" className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="type-h3">All checks</h3>
              <p className="text-xs text-muted-foreground">
                {view.counts.passing} passing · {view.counts.partial} partial · {view.counts.failing} failing · {view.counts.unknown} unknown
              </p>
            </div>
            <ul className="mt-2 divide-y">
              {view.checks.map((c) => (
                <CheckRow key={c.id} state={c.state} title={c.title} evidence={c.evidence} aside={<span>{checkedAt(c.checkedAt)}</span>} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );

  function saveHosting() {
    if (!view) return;
    const next = provider.trim() ? { provider: provider.trim(), region: region.trim() } : null;
    const prev = view.hostingOverride;
    if (next?.provider === prev?.provider && next?.region === prev?.region) return;
    if (!next && !prev) return;
    void save({ hostingOverride: next }, { hostingOverride: prev });
  }
}
