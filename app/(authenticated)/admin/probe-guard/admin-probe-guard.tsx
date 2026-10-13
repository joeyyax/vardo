"use client";

import { AllowlistCard } from "@/app/(authenticated)/admin/settings/allowlist-card";
import { AbuseReportingCard } from "@/app/(authenticated)/admin/settings/abuse-reporting-card";
import { BlockedCard } from "@/app/(authenticated)/admin/settings/blocked-card";
import { BansCard } from "./bans-card";
import { TrapsCard } from "./traps-card";
import { DisclosureCard } from "./disclosure-card";
import { ProbeRulesCard } from "./probe-rules-card";
import { BindMountsCard } from "./bind-mounts-card";
import { SpamhausCard } from "./spamhaus-card";

/** Instance-wide probe guard settings: bans, traps, lists, reporting, security.txt, probe rules. */
export function AdminProbeGuard() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="type-h2">Probe guard</h2>
        <p className="text-sm text-muted-foreground">Rules, lists and reporting behind the guard. Each section saves on its own.</p>
      </div>

      <nav aria-label="On this page" className="flex flex-wrap gap-1.5 text-xs">
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#bans">Bans</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#traps">Traps</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#never-ban">Never ban</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#abuse">AbuseIPDB</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#spamhaus">Spamhaus</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#blocked">Sources</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#disclosure">Disclosure</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#probe-rules">Probe rules</a>
        <a className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground hover:bg-accent" href="#bind-mounts">Bind mounts</a>
      </nav>

      <div className="space-y-6">
        <BansCard />
        <TrapsCard />
        <AllowlistCard version={0} onChange={() => {}} />
        <AbuseReportingCard />
        <SpamhausCard />
        <BlockedCard version={0} />
        <DisclosureCard />
        <ProbeRulesCard />
        <BindMountsCard />
      </div>
    </div>
  );
}