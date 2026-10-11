// Client-safe copy for the guard's counts and ban reasons.

export type GuardStatsView = { probes: number; bans: number; traps: number; permanent?: number };

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "142 probes turned away this week, 3 IPs banned". */
export function guardSummary(stats: GuardStatsView): string {
  const permanent = stats.permanent ? count(stats.permanent, "permanent ban") : null;
  if (stats.probes === 0 && stats.bans === 0 && stats.traps === 0) {
    return ["No probes turned away this week", permanent].filter(Boolean).join(", ");
  }
  const parts = [`${count(stats.probes, "probe")} turned away this week`, `${count(stats.bans, "IP")} banned`];
  if (stats.traps > 0) parts.push(`${count(stats.traps, "trap")} triggered`);
  if (permanent) parts.push(permanent);
  return parts.join(", ");
}

export type ProbeCount = { label: string; count: number };
export type PathCount = { path: string; count: number };

/** What an address did before its ban, from its recorded events. */
export type BanDetail = { categories: ProbeCount[]; paths: PathCount[]; trapPath: string | null };

export const SUMMARY_CATEGORIES = 3;

/** "Tried env files ×6, Git metadata ×2, +1 more". */
export function probeSummary(categories: readonly ProbeCount[], max = SUMMARY_CATEGORIES): string {
  const shown = categories.slice(0, max).map((c) => `${c.label} ×${c.count.toLocaleString("en-US")}`);
  const rest = categories.length - shown.length;
  return `Tried ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

export type BanReasonInput = {
  reason: string;
  originName: string | null;
  appName?: string | null;
  detail?: BanDetail | null;
};

function reasonText(ban: BanReasonInput): string {
  switch (ban.reason) {
    case "threshold":
      return ban.detail?.categories.length ? probeSummary(ban.detail.categories) : "Repeated probes";
    case "trap":
      return ban.detail?.trapPath ? `Fetched trap path ${ban.detail.trapPath}` : "Fetched a trap path";
    case "canary":
      return "Used a decoy credential";
    case "mesh":
      return ban.originName ? `Shared by ${ban.originName}` : "Shared by a linked instance";
    default:
      return ban.reason;
  }
}

/** One line on why an address is banned, with the app when known. */
export function banReasonLine(ban: BanReasonInput): string {
  const text = reasonText(ban);
  return ban.appName ? `${text} on ${ban.appName}` : text;
}
