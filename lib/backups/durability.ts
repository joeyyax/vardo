// Volume durability: whether a volume is irreplaceable, separate from `persistent`. Shared with the UI.

export type Durability =
  /** Irreplaceable. Back it up, with a strategy that suits what it is. */
  | "stateful"
  /** Cache, build artifacts, derived indexes, re-issuable certs. */
  | "rebuildable"
  /** The real copy lives elsewhere — object storage, a managed database. */
  | "external";

/** Database engine behind a volume, and the dump strategy that fits it. */
export type DatabaseKind = "postgres" | "mysql" | "mariadb" | "mongo";

export type DurabilityProposal = {
  durability: Durability;
  /** Set when the evidence also identifies a database engine. */
  kind?: DatabaseKind;
  /** Operator-facing evidence. Shown next to the proposal, never a bare verdict. */
  reason: string;
};

/** Whether the backup engine should capture this volume. Unclassified reads as yes. */
export function isBackupCandidate(durability: Durability | null | undefined): boolean {
  return durability !== "rebuildable" && durability !== "external";
}

/** Whether a backup job covers this volume. An explicit `stateful` is enough on its own. */
export function isBackupSelected(vol: {
  persistent: boolean;
  durability: Durability | null | undefined;
  backupSelection?: "include" | "exclude" | null;
}): boolean {
  if (!isBackupCandidate(vol.durability)) return false;
  if (vol.backupSelection) return vol.backupSelection === "include";
  return vol.durability === "stateful" || vol.persistent;
}

/** Why a volume was left out of a run. Null when it was captured. */
export function exclusionReason(durability: Durability | null | undefined): string | null {
  if (durability === "rebuildable") return "Rebuildable — reconstructed rather than restored";
  if (durability === "external") return "External — the durable copy lives outside this volume";
  return null;
}

// Proposals

const DATABASE_SIGNATURES: {
  kind: DatabaseKind;
  image: RegExp;
  dataDir: string;
}[] = [
  // Postgres images without "postgres" in the name. The data directory alone would match sidecars.
  {
    kind: "postgres",
    image: /(^|\/)(postgres|postgis|timescale|pgvector|pgvecto|citus|supabase|paradedb|pgautoupgrade|cloudnative-pg)/i,
    dataDir: "/var/lib/postgresql/data",
  },
  { kind: "mariadb", image: /(^|\/)(mariadb|percona)/i, dataDir: "/var/lib/mysql" },
  { kind: "mysql", image: /(^|\/)mysql/i, dataDir: "/var/lib/mysql" },
  { kind: "mongo", image: /(^|\/)mongo/i, dataDir: "/data/db" },
];

/** Paths and names that reconstruct themselves. Keep narrow: a wrong `rebuildable` is silent data loss. */
const REBUILDABLE_SIGNATURES: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|[-_/])cache([-_/]|$)/i, reason: "Cache — repopulates on use" },
  { pattern: /(^|[-_/])(letsencrypt|acme)([-_/]|$)/i, reason: "ACME certificates are re-issued on demand" },
  { pattern: /(^|[-_/])buildkit([-_/]|$)/i, reason: "Build cache — rebuilt by the next build" },
  { pattern: /(^|[-_/])(promtail|positions)([-_/]|$)/i, reason: "Log shipper positions — re-derived on start" },
  { pattern: /(^|[-_/])(tmp|temp)([-_/]|$)/i, reason: "Temporary working files" },
];

/** Suggest a durability class from what the volume is attached to. Null when nothing matches. */
export function proposeDurability(input: {
  /** Image of the container mounting this volume, when one is running. */
  image?: string | null;
  mountPath?: string | null;
  volumeName?: string | null;
}): DurabilityProposal | null {
  const image = input.image ?? "";
  const mountPath = input.mountPath ?? "";
  const volumeName = input.volumeName ?? "";

  // A database is judged on its image, corroborated by its data directory.
  for (const sig of DATABASE_SIGNATURES) {
    if (!sig.image.test(image)) continue;
    if (mountPath && mountPath !== sig.dataDir) continue;
    return {
      durability: "stateful",
      kind: sig.kind,
      reason: `${sig.kind} data directory — dump rather than archive the running files`,
    };
  }

  for (const sig of REBUILDABLE_SIGNATURES) {
    if (sig.pattern.test(mountPath) || sig.pattern.test(volumeName)) {
      return { durability: "rebuildable", reason: sig.reason };
    }
  }

  return null;
}

/** Whether a proposal may apply unconfirmed: only unclassified volumes, only toward more coverage. */
export function isSafeToApply(
  current: Durability | null | undefined,
  proposed: Durability,
): boolean {
  return (current ?? null) === null && proposed === "stateful";
}
