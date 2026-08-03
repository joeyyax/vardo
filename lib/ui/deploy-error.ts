// ---------------------------------------------------------------------------
// Failure detail for a header banner
//
// A plain app reads its failure off the deploy log. A stack whose last deploy
// succeeded reads it off whichever service is down.
// ---------------------------------------------------------------------------

const FAILURE_MARKERS = ["ERROR", "FATAL", "failed", "crashed"];

/** Last line of a deploy log that names the failure, timestamp stripped and tokens redacted. */
export function extractDeployError(log: string | null | undefined): string | null {
  if (!log) return null;
  const line = log
    .split("\n")
    .reverse()
    .find((l) => FAILURE_MARKERS.some((marker) => l.includes(marker)));
  const cleaned = line
    ?.replace(/^\[.*?\]\s*/, "")
    .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
    .replace(/ghs_[A-Za-z0-9]+/g, "***")
    .trim();
  return cleaned || null;
}

export type CrashableMember = { id: string; name: string; displayName: string; status: string };

export type CrashSummary = {
  crashed: CrashableMember[];
  /** Members that are neither up nor crashed — usually stopped in the same incident. */
  down: number;
  message: string;
};

/** Names the services that are actually down, for a stack whose deploy log says nothing. */
export function crashSummary(members: CrashableMember[]): CrashSummary | null {
  const crashed = members.filter((m) => m.status === "error");
  const down = members.filter((m) => m.status === "stopped" || m.status === "missing").length;
  if (crashed.length === 0 && down === 0) return null;

  const names = crashed.map((m) => m.displayName);
  const head =
    names.length === 0
      ? `${down} service${down === 1 ? "" : "s"} down`
      : names.length <= 2
        ? `${names.join(" and ")} crashed`
        : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more crashed`;
  const tail = crashed.length > 0 && down > 0 ? `, ${down} more down` : "";

  return { crashed, down, message: `${head}${tail}` };
}
