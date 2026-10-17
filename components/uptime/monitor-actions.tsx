"use client";

import { useState } from "react";
import { Bell, BellOff, CalendarClock, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import type { MonitorSummary, VantageView } from "@/lib/uptime/types";
import { MaintenanceDialog } from "./maintenance-dialog";
import { MonitorSheet, type CheckLink } from "./monitor-sheet";

/** Another check beside this one: the same app, and the same domain when it has one. */
function linkOf(m: MonitorSummary): CheckLink {
  const host = m.check.type === "http" ? new URL(m.check.url).hostname : m.check.host;
  const live = m.domainId && !m.domainRemoved ? m.domainId : undefined;
  return { appId: m.appId!, domains: live ? [{ id: live, host }] : [], domainId: live };
}

/**
 * What an operator does to one monitor: edit it, mute it, schedule maintenance, turn it on or off, delete a manual one, reset an edited
 * automatic one, add another check beside it. The Uptime page and the app's Uptime tab both render this, so they can't drift.
 */
export function MonitorActions({
  monitor: m,
  apiBase,
  vantages,
  checkedFrom,
  now,
  onChanged,
  onDeleted,
  compact = false,
}: {
  monitor: MonitorSummary;
  /** `/api/v1/organizations/<orgId>/uptime/monitors` */
  apiBase: string;
  vantages: VantageView[];
  checkedFrom?: string;
  now: number;
  onChanged: () => void;
  onDeleted: () => void;
  compact?: boolean;
}) {
  const url = `${apiBase}/${m.id}`;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const size = compact ? "sm" : "default";

  async function patch(path: string, body: unknown, method = "PATCH") {
    const res = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      toast.error((await res.json().catch(() => ({}))).error || "Couldn't save the change");
      return;
    }
    onChanged();
  }

  async function remove() {
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) {
      toast.success("Monitor deleted");
      onDeleted();
    } else {
      toast.error((await res.json().catch(() => ({}))).error || "Couldn't delete the monitor");
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size={size} variant="outline" onClick={() => setEditing(true)}>
        <Pencil /> Edit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="size-8 shrink-0 p-0" aria-label={`More actions for ${m.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => patch("/mute", { muted: !m.muted }, "POST")}>
            {m.muted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
            {m.muted ? "Unmute alerts" : "Mute alerts"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMaintenance(true)}>
            <CalendarClock className="size-4" /> Schedule maintenance
          </DropdownMenuItem>
          {m.appId && (
            <DropdownMenuItem onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add check
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => patch("", { enabled: !m.enabled })}>{m.enabled ? "Turn off" : "Turn on"}</DropdownMenuItem>
          {m.source === "auto" && m.overrides && (
            <DropdownMenuItem onClick={() => patch("", { resetOverrides: true })}>
              <RotateCcw className="size-4" /> Reset to automatic
            </DropdownMenuItem>
          )}
          {m.source === "manual" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleting(true)}>
                <Trash2 className="size-4" /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <MonitorSheet open={editing} onOpenChange={setEditing} apiBase={apiBase} vantages={vantages} checkedFrom={checkedFrom} monitor={m} onSaved={onChanged} />
      {m.appId && <MonitorSheet open={adding} onOpenChange={setAdding} apiBase={apiBase} vantages={vantages} checkedFrom={checkedFrom} link={linkOf(m)} onSaved={onChanged} />}
      <MaintenanceDialog open={maintenance} onOpenChange={setMaintenance} url={url} windows={m.maintenance} now={now} onSaved={onChanged} />
      <ConfirmDeleteDialog open={deleting} onOpenChange={setDeleting} title={`Delete ${m.name}?`} description="Its history is removed too." onConfirm={remove} />
    </div>
  );
}
