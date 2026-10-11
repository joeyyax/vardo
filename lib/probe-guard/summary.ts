// Client-safe copy for the guard's counts and ban reasons.

export type GuardStatsView = { probes: number; bans: number; traps: number };

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "142 probes turned away this week, 3 IPs banned". */
export function guardSummary(stats: GuardStatsView): string {
  if (stats.probes === 0 && stats.bans === 0 && stats.traps === 0) return "No probes turned away this week";
  const parts = [`${count(stats.probes, "probe")} turned away this week`, `${count(stats.bans, "IP")} banned`];
  if (stats.traps > 0) parts.push(`${count(stats.traps, "trap")} triggered`);
  return parts.join(", ");
}

export const BAN_REASON_LABEL: Record<string, string> = {
  threshold: "Repeated probes",
  trap: "Trap triggered",
  canary: "Decoy credential used",
  mesh: "Shared by a linked instance",
};
