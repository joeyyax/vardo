// Header pieces shared by the app header and the project header.

import { HelpTip } from "@/components/ui/help-tip";
import { priorityMeta } from "@/lib/ui/app-priority";
import {
  rollupIsSteady,
  rollupLabel,
  rollupTone,
  type HealthRollup,
} from "@/lib/ui/health-rollup";

export function HeaderStat({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="type-label text-muted-foreground/60 flex items-center gap-1">
        {label}
        {hint && <HelpTip label={label}>{hint}</HelpTip>}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

/** One dot and one phrase for a group of apps. `noun` is singular. */
export function RollupStatus({ rollup, noun }: { rollup: HealthRollup; noun: string }) {
  return (
    <span className={`flex items-center gap-1.5 ${rollupTone(rollup)}`}>
      <span
        aria-hidden="true"
        className={`size-2 rounded-full bg-current ${rollupIsSteady(rollup) ? "animate-pulse" : ""}`}
      />
      {rollupLabel(rollup, noun)}
    </span>
  );
}

/** Nothing for the standard tier — only the two tiers that change behavior show. */
export function PriorityCue({ priority }: { priority: string | null | undefined }) {
  const meta = priorityMeta(priority);
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <span className={`flex items-center gap-1 ${meta.tone}`} title={meta.title}>
      <Icon className="size-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}
