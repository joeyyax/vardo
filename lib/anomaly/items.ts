// Alert items for anomalies: what strayed, by how much, since when and what to check.

import { downsample } from "@/lib/alerts/host";
import type { AlertItem, AlertView } from "@/lib/bus/events";
import { severityRank, type AlertSeverity } from "@/lib/notifications/registry";
import type { SignalVerdict } from "./detect";
import type { TopProcess } from "./security";
import { SIGNALS, type SignalKey } from "./signals";

export type Finding = { signal: SignalKey; verdict: SignalVerdict; /** Last hour, oldest first. */ recent: number[] };

export type AppRef = { id: string; name: string };

const TITLE: Record<SignalKey, string> = {
  egress: "is sending {more} traffic than usual",
  cpu: "is using {more} CPU than usual",
  ingress: "is receiving {more} traffic than usual",
  pids: "is running {more} processes than usual",
  diskWrite: "is writing {more} to disk than usual",
};

/** "far more" only when critical. */
function title(app: AppRef, f: Finding): string {
  return `${app.name} ${TITLE[f.signal].replace("{more}", f.verdict.severity === "critical" ? "far more" : "more")}`;
}

const CHECK = "If nothing explains it, check its logs, recent deploys and running processes.";

function worst(severities: AlertSeverity[]): AlertSeverity {
  return severities.reduce<AlertSeverity>((a, b) => (severityRank(b) > severityRank(a) ? b : a), "warning");
}

/** "node 92% CPU, worker 40% CPU", busiest first. */
export function topProcessesFact(processes: TopProcess[] | null | undefined, limit = 3): { label: string; value: string }[] {
  if (!processes?.length) return [];
  const top = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, limit);
  return [{ label: "Top processes", value: top.map((p) => `${p.name} ${Math.round(p.cpu)}% CPU`).join(", ") }];
}

const RISE: Record<SignalKey, [verb: string, heading: string]> = {
  egress: ["Sending", "is sending {r} its usual traffic"],
  cpu: ["Using", "is using {r} its usual CPU"],
  ingress: ["Receiving", "is receiving {r} its usual traffic"],
  pids: ["Running", "is running {r} its usual number of processes"],
  diskWrite: ["Writing", "is writing {r} its usual amount to disk"],
};

/** What fired first, then holding signals that are still above typical. */
function reported(findings: Finding[]): Finding[] {
  const firing = findings.filter((f) => f.verdict.fires);
  const [lead, ...rest] = firing.length > 0 ? [...firing, ...findings.filter((f) => !f.verdict.fires)] : findings;
  return [lead, ...rest.filter((f) => f.verdict.fires || f.verdict.value > f.verdict.line.typical)];
}

/** "40×", "2.5×". */
function ratio(value: number, typical: number): string {
  const r = value / typical;
  return `${r >= 10 ? Math.round(r) : Number(r.toFixed(1))}×`;
}

/** Heading, lead and process table: each reading once. */
export function anomalyView(app: AppRef, findings: Finding[], top: TopProcess[] | null, newProcesses: string[] = []): AlertView {
  const [lead, ...rest] = reported(findings);
  const def = SIGNALS[lead.signal];
  const { value, line } = lead.verdict;
  const [verb, rise] = RISE[lead.signal];
  const heading = line.typical > 0 && value > line.typical ? `${app.name} ${rise.replace("{r}", ratio(value, line.typical))}` : undefined;
  const fresh = new Set(newProcesses);
  const busiest = top?.length ? [...top].sort((a, b) => b.cpu - a.cpu) : [];
  const first = `${verb} ${def.format(value)}, against a usual ${def.format(line.typical)} for this hour.`;
  const proc = busiest[0] && busiest[0].cpu >= 1 ? busiest[0] : undefined;
  const also = rest.filter((f) => !(proc && f.signal === "cpu")).map((f) => `${SIGNALS[f.signal].label} is up too: ${SIGNALS[f.signal].format(f.verdict.value)}, usually ${SIGNALS[f.signal].format(f.verdict.line.typical)}.`);
  const procLine = proc ? `A process called ${proc.name} is using ${SIGNALS.cpu.format(proc.cpu)}${fresh.has(proc.name) ? ", and it hasn't run in this app before" : ""}.` : undefined;
  return {
    heading,
    lead: [[first, ...also, procLine, CHECK].filter(Boolean).join(" ")],
    brief: { title: heading ?? title(app, lead), body: [first, procLine].filter(Boolean).join(" ") },
    seriesOver: line.threshold,
    table: busiest.length
      ? {
          columns: ["Process", "CPU"],
          rows: busiest.slice(0, 3).map((p) => ({
            name: p.name,
            why: fresh.has(p.name) ? "Not seen in this app before" : undefined,
            cells: [{ value: `${Math.round(p.cpu)}%`, hot: fresh.has(p.name) }],
          })),
        }
      : undefined,
  };
}

/** One item for every signal holding on the app, the most telling first. */
export function anomalyItem(app: AppRef, all: Finding[], top: TopProcess[] | null, newProcesses: string[] = []): AlertItem {
  const findings = reported(all);
  const [lead] = findings;
  const def = SIGNALS[lead.signal];
  const firing = findings.filter((f) => f.verdict.fires);
  const start = Math.min(...findings.map((f) => f.verdict.since));
  return {
    type: "app.anomaly",
    about: app.id,
    appId: app.id,
    appName: app.name,
    severity: worst((firing.length > 0 ? firing : findings).map((f) => f.verdict.severity)),
    title: title(app, lead),
    detail: `It's ${lead.verdict.severity === "critical" ? "well above" : "above"} its own normal for this time of day. ${CHECK}`,
    series: {
      title: `${def.label}, last hour`,
      values: downsample(lead.recent),
      caption: `Typical for this hour: ${def.format(lead.verdict.line.typical)}`,
    },
    facts: [
      ...findings.map((f) => ({
        label: SIGNALS[f.signal].label,
        value: `${SIGNALS[f.signal].format(f.verdict.value)} now, typically ${SIGNALS[f.signal].format(f.verdict.line.typical)}`,
      })),
      ...topProcessesFact(top),
    ],
    since: new Date(start).toISOString(),
    ...(findings.some((f) => f.verdict.sinceAtLeast && f.verdict.since === start) ? { sinceAtLeast: true } : {}),
    view: anomalyView(app, findings, top, newProcesses),
  };
}

/** These only flag outside deploy, restart and backup windows. */
function unexplained(app: AppRef, what: string): string {
  return `${app.name} hasn't ${what} before, and nothing was deployed or changed in Vardo around then. If you changed its settings yourself, there's nothing to do.`;
}

export function newProcessItem(app: AppRef, names: string[], since: number, top: TopProcess[] | null): AlertItem {
  return {
    type: "app.new-process",
    about: app.id,
    appId: app.id,
    appName: app.name,
    severity: "warning",
    title: names.length === 1 ? `${app.name} started a new process, ${names[0]}, without a deploy` : `${app.name} started ${names.length} new processes without a deploy`,
    detail: unexplained(app, names.length === 1 ? "run this process" : "run these processes"),
    facts: [{ label: names.length === 1 ? "Process" : "Processes", value: names.join(", ") }, ...topProcessesFact(top)],
    since: new Date(since).toISOString(),
  };
}

export function newPortItem(app: AppRef, ports: string[], since: number, top: TopProcess[] | null): AlertItem {
  return {
    type: "app.new-port",
    about: app.id,
    appId: app.id,
    appName: app.name,
    severity: "warning",
    title: ports.length === 1 ? `${app.name} opened ${ports[0]} without a deploy` : `${app.name} opened ${ports.length} new ports without a deploy`,
    detail: unexplained(app, ports.length === 1 ? "listened on this port" : "listened on these ports"),
    facts: [{ label: ports.length === 1 ? "Port" : "Ports", value: ports.join(", ") }, ...topProcessesFact(top)],
    since: new Date(since).toISOString(),
  };
}
