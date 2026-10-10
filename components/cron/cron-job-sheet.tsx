"use client";

import { useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { CRON_METHODS, HEADER_MASK, MAX_RETRIES } from "@/lib/cron/url-options";
import { SCHEDULE_PRESETS, type CronJob } from "./cron-shared";
import { TimeZoneSelect } from "@/components/time-zone-select";

type HeaderRow = { key: number; name: string; value: string; saved: boolean };

export type CronJobBody = {
  name: string;
  type: "command" | "url";
  schedule: string;
  /** Null runs in the server's zone. */
  timeZone: string | null;
  command: string;
  method?: string;
  headers?: { name: string; value?: string }[];
  timeoutMs?: number;
  retries?: number;
  expectedStatus?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job being edited; null to create. */
  job: CronJob | null;
  /** Command jobs are offered. False on org-level jobs. */
  allowCommand: boolean;
  /** The member may create or change a command job. */
  canCommand: boolean;
  description: string;
  onSave: (body: CronJobBody) => Promise<boolean>;
};

function initial(job: CronJob | null, allowCommand: boolean, canCommand: boolean) {
  const preset = job ? SCHEDULE_PRESETS.find((p) => p.value === job.schedule && p.value !== "custom") : undefined;
  return {
    name: job?.name ?? "",
    type: job?.type ?? (allowCommand && canCommand ? "command" : "url"),
    schedulePreset: job ? (preset ? job.schedule : "custom") : "0 * * * *",
    customSchedule: job && !preset ? job.schedule : "",
    timeZone: job?.timeZone ?? null,
    command: job?.command ?? "",
    method: job?.method ?? "GET",
    headers: (job?.headers ?? []).map((h, i) => ({ key: i, name: h.name, value: "", saved: true })),
    timeoutSec: String(Math.round((job?.timeoutMs ?? 30_000) / 1000)),
    retries: String(job?.retries ?? 0),
    expectedStatus: job?.expectedStatus ?? "",
  } as const;
}

/** Create or edit a cron job. Remount with a new `key` to reset. */
export function CronJobSheet({ open, onOpenChange, job, allowCommand, canCommand, description, onSave }: Props) {
  const [start] = useState(() => initial(job, allowCommand, canCommand));
  const nextKey = useRef(start.headers.length);
  const [name, setName] = useState(start.name);
  const [jobType, setJobType] = useState<"command" | "url">(start.type);
  const [schedulePreset, setSchedulePreset] = useState<string>(start.schedulePreset);
  const [customSchedule, setCustomSchedule] = useState(start.customSchedule);
  const [timeZone, setTimeZone] = useState<string | null>(start.timeZone);
  const [command, setCommand] = useState(start.command);
  const [method, setMethod] = useState(start.method);
  const [headers, setHeaders] = useState<HeaderRow[]>(start.headers);
  const [timeoutSec, setTimeoutSec] = useState(start.timeoutSec);
  const [retries, setRetries] = useState(start.retries);
  const [expectedStatus, setExpectedStatus] = useState(start.expectedStatus);
  const [saving, setSaving] = useState(false);

  const schedule = schedulePreset === "custom" ? customSchedule.trim() : schedulePreset;
  const timeout = Number(timeoutSec);
  const timeoutValid = Number.isInteger(timeout) && timeout >= 1 && timeout <= 300;
  const headersValid = headers.every((h) => h.name.trim() && (h.saved || h.value));
  const valid =
    name.trim() && command.trim() && schedule && (jobType === "command" || (timeoutValid && headersValid));

  function updateHeader(key: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    if (!valid) return;
    const body: CronJobBody = { name: name.trim(), type: jobType, schedule, timeZone, command: command.trim() };
    if (jobType === "url") {
      body.method = method;
      body.headers = headers.map((h) => ({
        name: h.name.trim(),
        value: h.saved && !h.value ? HEADER_MASK : h.value,
      }));
      body.timeoutMs = timeout * 1000;
      body.retries = Number(retries);
      body.expectedStatus = expectedStatus.trim() || null;
    }
    setSaving(true);
    try {
      if (await onSave(body)) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent>
        <BottomSheetHeader>
          <BottomSheetTitle>{job ? "Edit cron job" : "Add cron job"}</BottomSheetTitle>
          <BottomSheetDescription>{description}</BottomSheetDescription>
        </BottomSheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="cron-name">Name</Label>
              <Input
                id="cron-name"
                placeholder={allowCommand ? "Database cleanup" : "Site cron"}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cron-schedule">Schedule</Label>
              <Select value={schedulePreset} onValueChange={setSchedulePreset}>
                <SelectTrigger id="cron-schedule">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {schedulePreset === "custom" && (
                <Input
                  aria-label="Cron expression"
                  placeholder="*/5 * * * *"
                  className="font-mono"
                  value={customSchedule}
                  onChange={(e) => setCustomSchedule(e.target.value)}
                />
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cron-time-zone">Time zone</Label>
              <TimeZoneSelect id="cron-time-zone" value={timeZone} onChange={setTimeZone} inheritLabel="Server time (UTC unless TZ is set)" />
            </div>

            {allowCommand && (
              <div className="grid gap-2">
                <Label htmlFor="cron-type">Type</Label>
                <Select
                  value={jobType}
                  onValueChange={(v) => setJobType(v as "command" | "url")}
                  disabled={!canCommand && job !== null && jobType === "command"}
                >
                  <SelectTrigger id="cron-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="command" disabled={!canCommand}>Command (docker exec)</SelectItem>
                    <SelectItem value="url">URL (HTTP request)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="cron-command">{jobType === "url" ? "URL" : "Command"}</Label>
              <Input
                id="cron-command"
                placeholder={jobType === "url" ? "https://example.com/wp-cron.php" : "wp cron event run --due-now"}
                className="font-mono"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={jobType === "command" && !canCommand}
              />
              <p className="text-xs text-muted-foreground">
                {jobType === "url"
                  ? "Private and internal addresses need a trusted organization or the outbound allowlist."
                  : "Runs via docker exec inside your container."}
              </p>
              {allowCommand && !canCommand && (
                <p className="text-xs text-muted-foreground">Command jobs need an admin.</p>
              )}
            </div>

            {jobType === "url" && (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="cron-method">Method</Label>
                    <Select value={method} onValueChange={setMethod}>
                      <SelectTrigger id="cron-method">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CRON_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="cron-timeout">Timeout (seconds)</Label>
                    <Input
                      id="cron-timeout"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={300}
                      value={timeoutSec}
                      onChange={(e) => setTimeoutSec(e.target.value)}
                      aria-invalid={!timeoutValid}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="cron-retries">Retries</Label>
                    <Select value={retries} onValueChange={setRetries}>
                      <SelectTrigger id="cron-retries">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: MAX_RETRIES + 1 }, (_, n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n === 0 ? "None" : n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="cron-expected">Expected status</Label>
                  <Input
                    id="cron-expected"
                    placeholder="2xx"
                    className="font-mono"
                    value={expectedStatus}
                    onChange={(e) => setExpectedStatus(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Codes, classes or ranges, like 200,204 or 200-299. Blank means 2xx.</p>
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Request headers</Label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setHeaders((rows) => [...rows, { key: nextKey.current++, name: "", value: "", saved: false }])}
                    >
                      <Plus className="mr-1.5 size-3.5" />
                      Add header
                    </Button>
                  </div>
                  {headers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None. Values are stored encrypted and never shown again.</p>
                  ) : (
                    headers.map((h) => (
                      <div key={h.key} className="flex items-center gap-2">
                        <Input
                          aria-label="Header name"
                          placeholder="Authorization"
                          className="font-mono"
                          value={h.name}
                          onChange={(e) => updateHeader(h.key, { name: e.target.value })}
                        />
                        <Input
                          aria-label="Header value"
                          type="password"
                          autoComplete="off"
                          placeholder={h.saved ? "Saved, leave blank to keep" : "Value"}
                          className="font-mono"
                          value={h.value}
                          onChange={(e) => updateHeader(h.key, { value: e.target.value })}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label="Remove header"
                          onClick={() => setHeaders((rows) => rows.filter((r) => r.key !== h.key))}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <BottomSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !valid}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving...
              </>
            ) : job ? (
              "Update"
            ) : (
              "Create"
            )}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}
