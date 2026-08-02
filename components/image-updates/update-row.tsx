"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requiresMigration } from "@/lib/docker/image-updates/migration-path";
import type { ServiceUpdateStatus } from "@/lib/docker/image-updates/status";

export type ServiceUpdate = ServiceUpdateStatus;

/** Only a major bump earns color. A patch is routine and should read as routine. */
export function severityClass(severity: ServiceUpdate["severity"]): string {
  return severity === "major" ? "text-status-warning" : "text-foreground";
}

export function severityLabel(entry: ServiceUpdate): string {
  if (entry.status === "drift") return "rebuilt upstream";
  return entry.severity && entry.severity !== "unknown" ? entry.severity : "";
}

/** What a row will apply: the user's pick, else the safe default. */
export function defaultTarget(entry: ServiceUpdate, chosen?: string): string | null {
  return chosen ?? entry.latestTag ?? entry.majorAvailable ?? null;
}

const COLS = "sm:grid-cols-[minmax(6rem,10rem)_auto_1rem_13rem_minmax(0,1fr)_auto_auto]";
const COLS_SELECTABLE =
  "sm:grid-cols-[1.25rem_minmax(6rem,10rem)_auto_1rem_13rem_minmax(0,1fr)_auto_auto]";

/** Names the fact in each column: these tags come from compose, not the running containers. */
export function UpdateRowHeader({ selectable = false }: { selectable?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`hidden px-4 py-1.5 type-label text-muted-foreground/50 sm:grid sm:items-center sm:gap-x-3 ${
        selectable ? COLS_SELECTABLE : COLS
      }`}
    >
      {selectable && <span />}
      <span>Service</span>
      <span>In compose</span>
      <span />
      <span>Update to</span>
      <span />
      <span />
      <span />
    </div>
  );
}

type UpdateRowProps = {
  entry: ServiceUpdate;
  /** Tag this row will apply. */
  target: string | null;
  onTargetChange: (tag: string) => void;
  onApply: () => void;
  /** This row's own request is in flight. */
  applying?: boolean;
  disabled?: boolean;
  /** Second click arms the apply, for majors that are not migrations. */
  confirming?: boolean;
  /** Omit for a row that cannot be batched. */
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Names the row for a screen reader when the app is not in the row itself. */
  selectLabel?: string;
  /** Ignore control. Omit where ignoring is not offered. */
  ignoreSlot?: ReactNode;
};

export function UpdateRow({
  entry,
  target,
  onTargetChange,
  onApply,
  applying = false,
  disabled = false,
  confirming = false,
  selected,
  onSelectedChange,
  selectLabel,
  ignoreSlot,
}: UpdateRowProps) {
  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const migration = requiresMigration(entry.image, entry.currentTag, target);
  const label = severityLabel(entry);

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 ${
        selectable ? COLS_SELECTABLE : COLS
      }`}
    >
      {selectable && (
        <Checkbox
          checked={selected}
          disabled={disabled || applying}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={selectLabel ?? `Select ${entry.service ?? entry.image}`}
          className="row-start-1 self-center"
        />
      )}
      <span className="truncate font-mono text-xs text-muted-foreground">
        {entry.service}
        {/* The column that carries this is hidden on narrow screens. */}
        <span className="sm:hidden"> · {entry.currentTag}</span>
      </span>
      <span className="hidden whitespace-nowrap font-mono text-sm text-muted-foreground sm:inline">
        {entry.currentTag}
      </span>
      <ArrowRight className="hidden size-3 text-muted-foreground/40 sm:inline" aria-hidden="true" />
      {entry.available.length > 1 ? (
        <Select value={target ?? undefined} onValueChange={onTargetChange}>
          <SelectTrigger
            className="col-span-2 h-7 w-full font-mono sm:col-span-1"
            aria-label={`Version for ${entry.service ?? entry.image}`}
          >
            {/* Children, not the selected item's own markup — otherwise the
                dropdown's migration marker is echoed inside the trigger. */}
            <SelectValue>{target}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {entry.available.map((tag) => (
              <SelectItem key={tag} value={tag} className="font-mono">
                {tag}
                {requiresMigration(entry.image, entry.currentTag, tag) && (
                  <span className="ml-2 type-label text-status-warning">needs migration</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className={`whitespace-nowrap font-mono text-sm ${severityClass(entry.severity)}`}>
          {target ?? "rebuilt"}
        </span>
      )}
      {/* Never hidden by breakpoint — this is the warning that stops a
          datastore being pinned across a major it cannot start on. */}
      <span className="type-label truncate text-muted-foreground/50">
        {migration ? (
          <span className="text-status-warning">Needs migration</span>
        ) : (
          <span className="hidden sm:inline">{label}</span>
        )}
      </span>
      <Button
        size="sm"
        variant={migration ? "destructive" : confirming ? "default" : "outline"}
        disabled={applying || disabled}
        onClick={onApply}
      >
        {migration
          ? "Review migration"
          : confirming
            ? `Confirm ${target}`
            : applying
              ? "Applying…"
              : "Update"}
      </Button>
      {ignoreSlot ?? <span />}
    </div>
  );
}
