"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Visibility } from "@/lib/trust/types";
import type { TrustView } from "@/lib/trust/view";

export type TrustPatch = {
  visibility?: Visibility;
  domain?: string | null;
  name?: string | null;
  hostingOverride?: { provider: string; region: string } | null;
};

type Props = {
  view: TrustView;
  busy: boolean;
  save: (patch: TrustPatch, undo?: TrustPatch, message?: string) => Promise<void>;
};

const OPTIONS: { value: Visibility; label: string; hint: (domain: string | null) => string }[] = [
  { value: "off", label: "Off", hint: () => "No checks run." },
  { value: "private", label: "Private", hint: () => "Vardo runs the checks. Only admins see the results." },
  { value: "public", label: "Public", hint: (domain) => (domain ? `The page is live at ${domain}/trust.` : "Publishes a page for your clients at /trust.") },
];

export function trustUrl(domain: string): string {
  return `https://${domain}/trust`;
}

export function VisibilityCard({ view, busy, save }: Props) {
  const [pending, setPending] = useState<Visibility | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [domain, setDomain] = useState("");
  const shown = pending ?? view.visibility;

  function choose(next: Visibility) {
    if (next === view.visibility) return;
    if (next === "public") {
      setDomain(view.domain ?? (view.domains.length === 1 ? view.domains[0] : ""));
      setConfirming(true);
      return;
    }
    const previous = view.visibility;
    setPending(next);
    void save({ visibility: next }, { visibility: previous, domain: view.domain }, `Trust center ${next}`).finally(() => setPending(null));
  }

  async function publish() {
    const previous = view.visibility;
    setPending("public");
    setConfirming(false);
    await save({ visibility: "public", domain }, { visibility: previous, domain: view.domain }, "Trust center public");
    setPending(null);
  }

  return (
    <Card variant="surface" className="space-y-3 p-4">
      <div role="radiogroup" aria-label="Trust center visibility" className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((opt) => {
          const selected = shown === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => choose(opt.value)}
              className={cn(
                "squircle rounded-md border p-3 text-left transition-colors disabled:opacity-60",
                selected ? "border-primary bg-accent" : "hover:bg-muted",
              )}
            >
              <span className="block text-sm font-semibold">{opt.label}</span>
              <span className="block text-sm text-muted-foreground">{opt.hint(view.domain)}</span>
            </button>
          );
        })}
      </div>

      {pending && pending !== "off" ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" /> Running checks
        </p>
      ) : view.visibility === "public" && view.domain ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="trust-domain">Domain</Label>
            <Select
              value={view.domain}
              disabled={busy}
              onValueChange={(next) => void save({ domain: next }, { domain: view.domain }, "Domain saved")}
            >
              <SelectTrigger id="trust-domain" className="w-72"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[...new Set([view.domain, ...view.domains])].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={trustUrl(view.domain)} target="_blank" rel="noreferrer">{view.domain}/trust<ExternalLink className="size-3.5" /></a>
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Not hosting work for others? Leave it off, or use Private to audit this instance.</p>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make the trust center public</DialogTitle>
            <DialogDescription>Anyone with the link can read the page. Nothing goes live until you approve it here.</DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="trust-domain-pick">Domain</Label>
            {view.domains.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a domain to an app first. The page lives at /trust on one of this instance&apos;s domains.</p>
            ) : (
              <Select value={domain} onValueChange={setDomain}>
                <SelectTrigger id="trust-domain-pick" className="w-full"><SelectValue placeholder="Pick a domain" /></SelectTrigger>
                <SelectContent>
                  {view.domains.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {domain && <p className="text-sm text-muted-foreground">URL: <span className="font-mono text-foreground">{trustUrl(domain)}</span>. Other paths on {domain} stay with its app.</p>}
          </div>

          <div className="space-y-1.5 text-sm">
            <div className="font-medium">What becomes visible</div>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{view.operatorName} as the page&apos;s name</li>
              <li>Hosting provider and region</li>
              <li>Checks that pass, as plain outcomes with how recently they ran</li>
              <li>Commitments you turn on</li>
              <li>Policies and the agreement you review and publish</li>
              <li>Subprocessors you confirm</li>
            </ul>
            <p className="text-muted-foreground">Your score, counts and failing checks stay private.</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button onClick={() => void publish()} disabled={!domain || busy}>Make public</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
