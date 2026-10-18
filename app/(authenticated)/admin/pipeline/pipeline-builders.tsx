"use client";

import { Card } from "@/components/ui/card";
import { StatusMark } from "@/components/ui/status-dot";
import type { PipelineBuilder, PipelineSnapshot } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import { buildMedian, clock, isLive, span, waitsForBuilder } from "./timeline";

const KIND: Record<PipelineBuilder["kind"], string> = { local: "This server", mesh: "Linked instance", ssh: "SSH builder" };
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

function BuilderBlock({ b, snapshot, now }: { b: PipelineBuilder; snapshot: PipelineSnapshot; now: number }) {
  const byId = new Map(snapshot.deploys.map((d) => [d.id, d]));
  const seats = Array.from({ length: Math.max(b.slots, b.holders.length) }, (_, i) => b.holders[i] ?? null);
  const full = b.holders.length >= b.slots;
  const median = snapshot.medians.builders[b.id] ?? null;
  const frees = full
    ? Math.min(
        ...b.holders.map((h) => {
          const d = h.deploymentId ? byId.get(h.deploymentId) : undefined;
          const ms = d ? buildMedian(snapshot.medians, d.appId, b.id) : null;
          return h.since !== null && ms !== null ? Math.max(5_000, h.since + ms - now) : Infinity;
        }),
      )
    : null;
  const refusal = b.refusals[0];
  const refused = refusal ? (refusal.deploymentId ? byId.get(refusal.deploymentId)?.appName : null) : null;
  return (
    <div className="border-t py-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2">
        <b className="font-semibold">{b.name}</b>
        <span className="text-xs text-muted-foreground">{KIND[b.kind]}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {b.online === false ? <span className="text-status-warning">offline</span> : `${b.holders.length}/${b.slots}`}
        </span>
      </div>
      <div className="my-2 flex flex-wrap gap-1.5">
        {seats.map((h, i) => {
          if (!h) return <span key={i} className="squircle flex h-[30px] min-w-0 flex-[1_1_120px] items-center rounded-lg px-2.5 text-[12.5px] text-muted-foreground ring-1 ring-foreground/20 ring-inset">Free</span>;
          const d = h.deploymentId ? byId.get(h.deploymentId) : undefined;
          return (
            <span key={h.token} className="squircle flex h-[30px] min-w-0 flex-[1_1_120px] items-center gap-1.5 overflow-hidden rounded-lg bg-accent px-2.5 text-[12.5px] whitespace-nowrap">
              <StatusMark tone="signal" pending />
              <span className="truncate">{d ? d.appName : "Its own build"}</span>
              {h.since !== null ? <span className="ml-auto font-mono text-[11.5px] tabular-nums text-muted-foreground">{clock(now - h.since)}</span> : null}
            </span>
          );
        })}
      </div>
      {frees !== null && Number.isFinite(frees) ? (
        <div className="text-[12.5px] text-muted-foreground">
          Frees in about {span(frees)}
          {median ? <span className="text-muted-foreground/70"> · median build {clock(median)}</span> : null}
        </div>
      ) : null}
      {refusal ? (
        <div className="text-[12.5px] text-status-warning">
          Refused {refused ?? "a build"} {span(now - refusal.at)} ago
          {refusal.needBytes !== null && refusal.freeBytes !== null ? `: needs ${gib(refusal.needBytes)} GiB, ${gib(refusal.freeBytes)} free` : b.busy ? ": busy with its own builds" : ""}
        </div>
      ) : null}
    </div>
  );
}

export function PipelineBuilders({ snapshot, now }: { snapshot: PipelineSnapshot; now: number }) {
  const waiting = snapshot.deploys.filter((d) => isLive(d) && waitsForBuilder(d)).length;
  return (
    <Card variant="surface" className="p-5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="type-h4">Builders</h2>
        <span className={cn("font-mono text-xs text-muted-foreground", waiting && "text-status-warning")}>{waiting ? `${waiting} waiting` : "none waiting"}</span>
      </div>
      {snapshot.builders.map((b) => (
        <BuilderBlock key={b.id} b={b} snapshot={snapshot} now={now} />
      ))}
    </Card>
  );
}
