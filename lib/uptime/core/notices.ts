// Notices waiting to go out. Those from one instance for one audience and kind within 60 seconds go as one.

export const GROUP_WINDOW_MS = 60_000;

export type NoticeKind = "down" | "recovered" | "flapping" | "settled";

export type Notice = {
  at: number;
  kind: NoticeKind;
  /** Who hears it: the orgs, joined. */
  audience: string;
  monitorId: string;
  /** The monitor's name, never its id. */
  name: string;
  /** "pouch.email is down". */
  title: string;
  detail: string;
};

const groupOf = (n: Notice) => `${n.audience}\n${n.kind}`;

/** Splits pending notices into groups whose oldest notice has waited the window, and the rest. */
export function dueGroups(pending: Notice[], now: number, windowMs = GROUP_WINDOW_MS): { due: Notice[][]; rest: Notice[] } {
  const groups = new Map<string, Notice[]>();
  for (const n of pending) {
    const list = groups.get(groupOf(n));
    if (list) list.push(n);
    else groups.set(groupOf(n), [n]);
  }
  const due: Notice[][] = [];
  const rest: Notice[] = [];
  for (const list of groups.values()) {
    if (now - Math.min(...list.map((n) => n.at)) >= windowMs) due.push(list);
    else rest.push(...list);
  }
  return { due, rest };
}

const VERB: Record<NoticeKind, string> = { down: "down", recovered: "recovered", flapping: "flapping", settled: "settled" };

/** One notification for a group: a single notice reads as itself, several as "jy0: 12 monitors down" with the list. */
export function describeGroup(instance: string, group: Notice[]): { subject: string; title: string; message: string } {
  if (group.length === 1) return { subject: group[0].title, title: group[0].title, message: group[0].detail };
  const kind = group[0].kind;
  const title = `${instance}: ${group.length} monitors ${VERB[kind]}`;
  const names = [...new Set(group.map((n) => n.name))].sort((a, b) => a.localeCompare(b));
  return { subject: title, title, message: names.map((n) => `- ${n}`).join("\n") };
}
