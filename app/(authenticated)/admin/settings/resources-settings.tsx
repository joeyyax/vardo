"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/messenger";
import {
  isAdminResourceKey,
  validateAdminValue,
  type DefaultSource,
  type HostSize,
  type ResourceDefault,
} from "@/lib/resources/defaults";
import { FORMULA_NOTES, formulaTable, hostSummary } from "@/lib/ui/resource-formulas";

type Data = {
  host: HostSize | null;
  hostCpus: number;
  defaults: ResourceDefault[];
};

const SOURCE_LABEL: Record<DefaultSource, string> = {
  detected: "Detected",
  override: "Overridden",
  admin: "Admin",
  fallback: "Fallback",
};

const SOURCE_VARIANT: Record<DefaultSource, "success" | "warning" | "neutral" | "info"> = {
  detected: "success",
  override: "neutral",
  admin: "info",
  fallback: "warning",
};

const UNIT_SUFFIX: Record<ResourceDefault["unit"], string> = { mb: "MB", cpus: "CPUs", count: "" };

function formatMb(mb: number): string {
  return mb >= 1024 && mb % 256 === 0 ? `${mb / 1024} GiB` : `${mb} MB`;
}

function formatValue(row: ResourceDefault, value: number | null): string {
  if (value === null) return row.unit === "cpus" ? "No cap" : "Unknown";
  if (row.unit === "mb") return formatMb(value);
  if (row.unit === "cpus") return `${value} ${value === 1 ? "CPU" : "CPUs"}`;
  return String(value);
}

/** The .env value install.sh would write for this row's rule. */
function envValue(row: ResourceDefault): string {
  const mb = row.rule ?? 0;
  if (row.key === "buildkitMem") return `${mb / 1024}g`;
  if (row.key === "buildkitCache") return String(mb * 1024 ** 2);
  if (row.key === "redisMaxmemory") return `${mb}mb`;
  return `${mb}m`;
}

function gapOf(row: ResourceDefault): boolean {
  return row.installer && row.running != null && row.rule != null && row.running !== row.rule;
}

const RESTART_TARGET: Partial<Record<ResourceDefault["key"], string>> = {
  buildkitMem: "vardo-buildkit",
  redisMem: "vardo-redis",
  redisMaxmemory: "vardo-redis",
};

/** Input, reset and save for a default an admin can set. */
function EditableValue({
  row,
  hostCpus,
  onSave,
}: {
  row: ResourceDefault;
  hostCpus: number;
  onSave: (key: ResourceDefault["key"], value: number | null) => Promise<boolean>;
}) {
  const current = row.value === null ? "" : String(row.value);
  const [draft, setDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  const dirty = draft.trim() !== current;
  const parsed = Number(draft);
  const problem =
    dirty && isAdminResourceKey(row.key)
      ? draft.trim() === ""
        ? "Enter a value or use the default."
        : validateAdminValue(row.key, parsed, hostCpus)
      : null;

  async function save(value: number | null) {
    setSaving(true);
    await onSave(row.key, value);
    setSaving(false);
  }

  const id = `resource-${row.key}`;
  return (
    <form
      className="flex flex-col gap-1 sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !problem) void save(parsed);
      }}
    >
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {row.label}
        </label>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={row.unit === "cpus" ? 0.25 : row.unit === "mb" ? 128 : 1}
          step={row.unit === "cpus" ? 0.25 : 1}
          className="h-8 w-28 text-right tabular-nums"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
          disabled={saving}
        />
        {UNIT_SUFFIX[row.unit] && <span className="text-xs text-muted-foreground">{UNIT_SUFFIX[row.unit]}</span>}
        {dirty && (
          <Button type="submit" size="xs" disabled={saving || !!problem}>
            {saving ? <Loader2 className="animate-spin" /> : "Save"}
          </Button>
        )}
      </div>
      {problem && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {row.source === "admin" && (
        <Button type="button" variant="ghost" size="xs" disabled={saving} onClick={() => void save(null)}>
          Use default ({formatValue(row, row.rule)})
        </Button>
      )}
    </form>
  );
}

export function ResourcesSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  async function saveValue(key: ResourceDefault["key"], value: number | null): Promise<boolean> {
    try {
      const res = await fetch("/api/v1/admin/resources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { [key]: value } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Couldn't save");
        return false;
      }
      setData(body);
      toast.success(value === null ? "Reset to the default" : "Saved");
      return true;
    } catch {
      toast.error("Couldn't reach the server");
      return false;
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/admin/resources");
        if (!res.ok) throw new Error("Couldn't fetch");
        setData(await res.json());
      } catch {
        toast.error("Couldn't load resource defaults");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading resource defaults</span>
      </div>
    );
  }
  if (!data) return null;

  const { host } = data;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="type-h2">Resources</h2>
        <p className="text-sm text-muted-foreground">
          Sizing defaults computed from the host&apos;s CPUs and memory, read from Docker each time Vardo
          starts. An env var wins over your value, and your value wins over the formula.
        </p>
        <p className="text-sm text-muted-foreground">Changes apply to each app on its next deploy.</p>
      </div>

      <Card variant="surface" className="p-4">
        {host ? (
          <p className="text-sm">{hostSummary(host, data.defaults)}</p>
        ) : (
          <p className="text-sm text-status-warning">
            Couldn&apos;t read the host&apos;s size from Docker, so the fixed fallbacks apply.
          </p>
        )}
      </Card>

      <Card variant="surface" className="divide-y">
        {data.defaults.map((row) => {
          const envLocked = row.editable && row.source === "override";
          return (
            <div key={row.key} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.label}</span>
                  <Badge variant={SOURCE_VARIANT[row.source]}>{SOURCE_LABEL[row.source]}</Badge>
                  {envLocked && (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      <Lock className="size-3" />
                      Set by {row.envVar}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  <code>{row.envVar}</code>
                  {row.source !== "detected" && row.source !== "admin" && (
                    <> · rule for this host: {formatValue(row, row.rule)}</>
                  )}
                  {row.installer && <> · set in .env by install.sh</>}
                </div>
                {gapOf(row) && (
                  <div className="text-xs text-status-warning">
                    Running with {formatValue(row, row.running ?? null)}; the rule suggests{" "}
                    {formatValue(row, row.rule)}. Set <code>{row.envVar}={envValue(row)}</code> in .env and
                    recreate {RESTART_TARGET[row.key]}.
                  </div>
                )}
              </div>
              {row.editable && !envLocked ? (
                <EditableValue key={`${row.key}:${row.value}`} row={row} hostCpus={data.hostCpus} onSave={saveValue} />
              ) : (
                <span className="text-sm tabular-nums sm:text-right">
                  {formatValue(row, row.installer && row.running != null ? row.running : row.value)}
                </span>
              )}
            </div>
          );
        })}
      </Card>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Formulas</h3>
        <Card variant="surface" className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="p-3 font-medium">Default</th>
                <th className="p-3 font-medium">Formula</th>
                <th className="p-3 text-right font-medium">On this server</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {formulaTable(data.defaults).map((row) => (
                <tr key={row.key}>
                  <td className="p-3 font-medium">{row.label}</td>
                  <td className="p-3 text-muted-foreground">{row.formula}</td>
                  <td className="p-3 text-right tabular-nums">{host ? (row.here ?? "–") : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {FORMULA_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
