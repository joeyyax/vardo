"use client";

import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import {  } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { BuildPlanRecord } from "@/lib/docker/build-plan";

const ENGINE: Record<BuildPlanRecord["engine"], string> = { railpack: "Railpack", nixpacks: "Nixpacks" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono">{children}</dd>
    </>
  );
}

/** The Railpack or Nixpacks plan a deploy built from. */
export function BuildPlanPanel({ plan, id }: { plan: BuildPlanRecord; id?: string }) {
  const s = plan.summary;
  const engine = `${ENGINE[plan.engine]}${plan.version ? ` ${plan.version}` : ""}`;
  const provider = s.providers.join(", ") || "no provider";
  const override = " (override)";

  return (
    <Collapsible id={id} className="border-t border-border/60">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-foreground/80 transition-colors hover:text-foreground">
        <DisclosureChevron />
        <span className="font-medium">Build plan</span>
        <span className="truncate text-muted-foreground">
          {provider} · {engine}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 px-4 pb-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <Row label="Builder">{engine}</Row>
            <Row label="Provider">{provider}</Row>
            {s.evidence.length > 0 && <Row label="Detected from">{s.evidence.join(", ")}</Row>}
            {s.languages.length > 0 && <Row label="Language">{s.languages.join(", ")}</Row>}
            <Row label="Install">{s.install.join(" && ") || "None"}</Row>
            <Row label="Build">
              {s.build.join(" && ") || "None"}
              {plan.overrides.buildCommand && override}
            </Row>
            <Row label="Start">
              {s.start ?? "None"}
              {plan.overrides.startCommand && override}
            </Row>
            {s.notes.length > 0 && <Row label="Notes">{s.notes.join("; ")}</Row>}
            {s.errors.length > 0 && (
              <Row label="Errors">
                <span className="text-status-error">{s.errors.join("; ")}</span>
              </Row>
            )}
          </dl>
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <DisclosureChevron className="text-current" />
              Full plan
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-background-deep p-3 font-mono text-xs leading-5">
                {JSON.stringify(plan.plan, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
