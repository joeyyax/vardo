// UPS transitions as notices: incidents for on-battery and lost contact, plain alerts for the rest.

import type { SystemPowerEvent } from "@/lib/bus/events";
import { db } from "@/lib/db";
import { formatDuration } from "@/lib/email/format";
import { emitSystemIncident, resolveSystemIncident, type SystemProblem } from "@/lib/incidents/system";
import { emit } from "@/lib/notifications/dispatch";
import type { UpsServerRow } from "@/lib/db/schema";
import type { UpsState, UpsTransition } from "./status";

export type UpsSubject = Pick<UpsServerRow, "id" | "name" | "host" | "port">;

export type UpsNotice =
  | { action: "open"; event: SystemPowerEvent; problem: SystemProblem }
  | { action: "send"; event: SystemPowerEvent }
  | { action: "resolve"; kind: SystemProblem["kind"]; about: string; detail: string };

function batteryFacts(state: UpsState): string {
  const r = state.reading;
  const parts: string[] = [];
  if (r?.charge != null) parts.push(`charge ${r.charge}%`);
  if (r?.runtime != null) parts.push(`about ${formatDuration(r.runtime * 1000)} of runtime`);
  if (r?.load != null) parts.push(`load ${r.load}%`);
  if (parts.length === 0) return "";
  const text = parts.join(", ");
  return ` ${text[0].toUpperCase()}${text.slice(1)}.`;
}

function eventFor(ups: UpsSubject, state: UpsState, change: SystemPowerEvent["change"], title: string, message: string): SystemPowerEvent {
  const r = state.reading;
  return {
    type: "system.power",
    title,
    message,
    change,
    ups: { id: ups.id, name: ups.name, ...(r?.model ? { model: r.model } : {}) },
    ...(r?.charge != null ? { charge: r.charge } : {}),
    ...(r?.runtime != null ? { runtimeSec: r.runtime } : {}),
    ...(r?.load != null ? { load: r.load } : {}),
    ...(change === "test-failed" && r?.testResult ? { testResult: r.testResult } : {}),
  };
}

/** The notice for a transition, or null when it sends nothing. */
export function noticeFor(ups: UpsSubject, t: UpsTransition, state: UpsState, now: Date): UpsNotice | null {
  const name = ups.name;
  if (t.kind === "cleared") {
    const lasted = formatDuration(Math.max(0, now.getTime() - Date.parse(t.firedAt)));
    if (t.condition === "on-battery") {
      return { action: "resolve", kind: "ups.on-battery", about: ups.id, detail: `Power is back on ${name} after ${lasted} on battery.${batteryFacts(state)}` };
    }
    if (t.condition === "contact-lost") {
      return { action: "resolve", kind: "ups.contact-lost", about: ups.id, detail: `${name} is answering again after ${lasted}.` };
    }
    return null;
  }

  switch (t.condition) {
    case "on-battery": {
      const title = `${name} is on battery`;
      return {
        action: "open",
        event: eventFor(ups, state, "on-battery", title, `${name} lost line power and is running on battery.${batteryFacts(state)}`),
        problem: { kind: "ups.on-battery", about: ups.id, title, severity: "critical" },
      };
    }
    case "contact-lost": {
      const title = `Lost contact with ${name}`;
      const why = state.lastError ? ` Last error: ${state.lastError}.` : "";
      return {
        action: "open",
        event: eventFor(ups, state, "contact-lost", title, `${ups.host}:${ups.port} hasn't answered ${state.failedPolls} polls in a row.${why}`),
        problem: { kind: "ups.contact-lost", about: ups.id, title, severity: "warning" },
      };
    }
    case "low-battery":
      return { action: "send", event: eventFor(ups, state, "low-battery", `${name} battery is low`, `${name} reports a low battery.${batteryFacts(state)}`) };
    case "replace-battery":
      return { action: "send", event: eventFor(ups, state, "replace-battery", `${name} needs a new battery`, `${name} reports its battery needs replacing.`) };
    case "test-failed":
      return {
        action: "send",
        event: eventFor(ups, state, "test-failed", `${name} failed its self-test`, `${name} reports its last self-test as "${state.reading?.testResult ?? "failed"}".`),
      };
  }
}

async function allOrgIds(): Promise<string[]> {
  const orgs = await db.query.organizations.findMany({ columns: { id: true } });
  return orgs.map((o) => o.id);
}

/** Sends each transition's notice to every org, as system alerts do. */
export async function deliverTransitions(ups: UpsSubject, transitions: UpsTransition[], state: UpsState, now: Date): Promise<void> {
  const notices = transitions.map((t) => noticeFor(ups, t, state, now)).filter((n): n is UpsNotice => n !== null);
  if (notices.length === 0) return;
  const orgIds = await allOrgIds();
  for (const notice of notices) {
    if (notice.action === "open") await emitSystemIncident(orgIds, notice.event, notice.problem, now);
    else if (notice.action === "resolve") await resolveSystemIncident(orgIds, notice.kind, notice.about, notice.detail, now);
    else for (const orgId of orgIds) emit(orgId, notice.event);
  }
}
