"use client";

import { useState } from "react";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Term } from "@/components/term";
import { EntityLink } from "@/components/entity-link";
import { cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { describeMajorNotice } from "@/lib/attention/major-notice-rows";
import { requiresMigration } from "@/lib/docker/image-updates/migration-path";
import type { TrackMode } from "@/lib/docker/image-updates/track-policy";
import type { ServiceUpdate } from "./update-row";

export type MajorEntry = {
  /** Stable across renders: app and service. */
  key: string;
  appId: string;
  service: ServiceUpdate;
  /** App label and link, shown in fleet views. */
  app?: { displayName: string; href: string };
};

/** "Stay on 16", or a generic label when the running tag names no major. */
export function stayLabel(service: ServiceUpdate): string {
  return service.track.major !== null ? `Stay on ${service.track.major}` : "Stay on this major";
}

/** The section opens on its own only when a major needs a decision now. */
export function opensByDefault(entries: MajorEntry[]): boolean {
  return entries.some((entry) => entry.service.reasons.length > 0);
}

/** Services with a new major or a reason to decide, one entry each. */
export function majorEntries(
  items: { appId: string; service: ServiceUpdate; app?: MajorEntry["app"] }[],
): MajorEntry[] {
  const seen = new Set<string>();
  const entries: MajorEntry[] = [];
  for (const item of items) {
    const { service } = item;
    if (!service.majorAvailable && service.reasons.length === 0) continue;
    const key = `${item.appId}:${service.service ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, ...item });
  }
  // Offered before held.
  return entries.sort((a, b) => Number(a.service.majorHeld) - Number(b.service.majorHeld));
}

type Handlers = {
  busyKey?: string | null;
  disabled?: boolean;
  onTrack: (entry: MajorEntry, mode: TrackMode) => void;
  onPlan: (entry: MajorEntry, tag: string) => void;
};

/** New majors, apart from updates and never counted. Collapsed unless one needs a decision. */
export function MajorVersions({ entries, ...handlers }: { entries: MajorEntry[] } & Handlers) {
  const [open, setOpen] = useState(() => opensByDefault(entries));

  if (entries.length === 0) return null;

  const withMajor = entries.filter((entry) => entry.service.majorAvailable);
  const held = withMajor.filter((entry) => entry.service.majorHeld).length;
  const summary = [
    withMajor.length - held > 0 && `${withMajor.length - held} offered`,
    held > 0 && `${held} held`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      id="major-versions"
      aria-label="New major versions"
      className={cn(cardVariants({ variant: "surface" }), "overflow-hidden")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left type-body-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <DisclosureChevron open={open} />
        <span>
          New <Term id="major-version" passive>major versions</Term> ({entries.length})
        </span>
        <span className="type-label ml-auto truncate text-muted-foreground/50">{summary}</span>
      </button>

      {open && (
        <ul className="divide-y border-t bg-background-deep">
          {entries.map((entry) => (
            <MajorRow key={entry.key} entry={entry} {...handlers} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MajorRow({ entry, busyKey, disabled, onTrack, onPlan }: { entry: MajorEntry } & Handlers) {
  const { service } = entry;
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const tag = chosen ?? service.majorAvailable;
  const busy = busyKey === entry.key;
  const label = service.service ?? service.image;

  function plan(target: string) {
    // A migration opens its own dialog; anything else arms on the first click.
    if (!requiresMigration(service.image, service.currentTag, target) && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onPlan(entry, target);
  }

  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {entry.app && (
          <EntityLink href={entry.app.href} className="type-body-sm">
            {entry.app.displayName}
          </EntityLink>
        )}
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground">
          {service.currentTag}
          {tag && <ArrowRight className="size-3 text-muted-foreground/40" aria-hidden="true" />}
          {tag && service.majorTags.length > 1 ? (
            <Select
              value={tag}
              onValueChange={(next) => {
                setChosen(next);
                setConfirming(false);
              }}
            >
              <SelectTrigger className="h-7 w-32 font-mono" aria-label={`Major version for ${label}`}>
                <SelectValue>{tag}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {service.majorTags.map((option) => (
                  <SelectItem key={option} value={option} className="font-mono">
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            tag && <span>{tag}</span>
          )}
        </span>
        {service.majorHeld && (
          <span className="type-label text-muted-foreground/60">
            <Term id="stay-on-major" passive>
              Staying on {service.track.major ?? "this major"}
            </Term>
          </span>
        )}
        {tag && (
          <span className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || disabled}
              onClick={() => onTrack(entry, service.majorHeld ? "latest" : "major")}
            >
              {service.majorHeld ? "Follow latest" : stayLabel(service)}
            </Button>
            <Button
              size="sm"
              variant={confirming ? "default" : "outline"}
              disabled={busy || disabled}
              onClick={() => plan(tag)}
            >
              {busy ? "Applying…" : confirming ? `Confirm ${tag}` : "Plan upgrade"}
            </Button>
          </span>
        )}
      </div>
      {service.reasons.length > 0 && (
        <p className="flex items-start gap-1.5 type-body-sm text-status-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {describeMajorNotice({ ...service, majorAvailable: null })}
        </p>
      )}
    </li>
  );
}
