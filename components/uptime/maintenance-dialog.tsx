"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MaintenanceWindow } from "@/lib/uptime/types";

const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** `datetime-local` text for an epoch, in the browser's zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** Schedules windows that mute alerts. Downtime inside them still counts toward uptime. */
export function MaintenanceDialog({
  open,
  onOpenChange,
  url,
  windows,
  now,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The monitor's API url. */
  url: string;
  windows: MaintenanceWindow[];
  /** Epoch ms, from the page. */
  now: number;
  onSaved: () => void;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [saving, setSaving] = useState(false);

  const [seen, setSeen] = useState(open);
  if (seen !== open) {
    setSeen(open);
    if (open) {
      setStart(toLocalInput(now));
      setEnd(toLocalInput(now + 3_600_000));
    }
  }

  const upcoming = windows.filter((w) => w.end > now);

  async function save(next: MaintenanceWindow[]) {
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maintenance: next }),
      });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error || "Couldn't save the window");
        return;
      }
      onSaved();
      return true;
    } catch {
      toast.error("Couldn't save the window");
    } finally {
      setSaving(false);
    }
  }

  async function add() {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!(e > s)) return toast.error("The window must end after it starts");
    if (await save([...upcoming, { start: s, end: e }])) {
      toast.success("Maintenance scheduled");
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule maintenance</DialogTitle>
          <DialogDescription>Alerts are muted during a window. Downtime still counts toward uptime.</DialogDescription>
        </DialogHeader>

        {upcoming.length > 0 && (
          <ul className="space-y-1.5 text-sm">
            {upcoming.map((w) => (
              <li key={w.start} className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5">
                <span>
                  {fmt.format(w.start)} to {fmt.format(w.end)}
                </span>
                <Button variant="ghost" size="icon-xs" aria-label="Remove window" disabled={saving} onClick={() => save(upcoming.filter((x) => x !== w))}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="maint-start">Starts</Label>
            <Input id="maint-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="maint-end">Ends</Label>
            <Input id="maint-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={add} disabled={saving || !start || !end}>
            {saving && <Loader2 className="animate-spin" />}
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
