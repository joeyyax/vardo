// Policy drafts written from settings. Each sentence states what a setting does; none promises anything for the operator.

import { createHash } from "crypto";
import { hoursText } from "./commitments";

export const POLICY_IDS = ["backup", "access", "incident"] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

export type PolicyFacts = {
  name: string;
  backup: {
    jobs: boolean;
    recoveryPointHours: number | null;
    retentionDays: number | null;
    /** Every enabled job stores off the host. */
    offHost: boolean;
    /** The newest backup of every enabled job is encrypted. */
    encrypted: boolean;
  };
  access: {
    methods: string[];
    registration: "closed" | "open" | "approval";
    sessionDays: number;
  };
  incident: {
    securityContact: string | null;
    breachNotification: string | null;
    email: boolean;
    backupFailureAlerts: boolean;
  };
};

export const POLICY_META: Record<PolicyId, { title: string; description: string }> = {
  backup: { title: "Backup and recovery policy", description: "How backups run, where they go and how long they're kept." },
  access: { title: "Access control policy", description: "Who can reach client data and how they sign in." },
  incident: { title: "Incident response policy", description: "How problems are surfaced and reported." },
};

/** Words joined as "a, b and c". */
export function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const METHOD_NAMES: Record<string, string> = {
  password: "a password",
  passkey: "a passkey",
  "magic-link": "an emailed link",
  totp: "an authenticator app",
  github: "GitHub",
};

function backupPolicy(f: PolicyFacts): string {
  const b = f.backup;
  const out = [`${f.name} runs on Vardo. This policy describes how backups are configured on that platform.`];
  if (!b.jobs) return [...out, "No backup jobs are enabled."].join("\n\n");

  const schedule: string[] = [];
  if (b.recoveryPointHours) schedule.push(`Backups run on a schedule. The longest gap between runs is ${hoursText(b.recoveryPointHours)}.`);
  else schedule.push("Backups run on a schedule.");
  out.push(`## Schedule\n${schedule.join(" ")}`);

  const storage: string[] = [];
  if (b.offHost) storage.push("- Backups are stored off the host, with an external storage provider.");
  if (b.encrypted) storage.push("- Backups are encrypted before they're stored.");
  if (storage.length) out.push(`## Storage\n${storage.join("\n")}`);

  if (b.retentionDays) out.push(`## Retention\nBackups are kept for ${b.retentionDays} ${b.retentionDays === 1 ? "day" : "days"}, then removed by the job's retention rules.`);

  out.push("## Verification\nVardo restores backups into a scratch location to check them. It rotates through every volume, oldest verification first, and a verification stands for seven days.");
  out.push("## Recovery\nAn administrator starts a restore from the backups page.");
  return out.join("\n\n");
}

function accessPolicy(f: PolicyFacts): string {
  const a = f.access;
  const out = [`${f.name} runs on Vardo. This policy describes how access is configured on that platform.`];

  const methods = a.methods.map((m) => METHOD_NAMES[m]).filter(Boolean);
  const signIn: string[] = [];
  signIn.push(methods.length ? `People sign in with ${list(methods)}.` : "No sign-in method is enabled.");
  if (a.methods.includes("passkey") || a.methods.includes("totp")) signIn.push("Passkeys and authenticator apps give two-step sign-in.");
  out.push(`## Sign-in\n${signIn.join(" ")}`);

  const registration = { closed: "New accounts are created by invitation.", open: "Anyone can register an account.", approval: "New registrations wait for approval." }[a.registration];
  out.push(`## Accounts\n${registration} Sessions last ${a.sessionDays} ${a.sessionDays === 1 ? "day" : "days"}.`);

  out.push(
    [
      "## Data access",
      "- Client data is separated by organization. Members reach only the organizations they belong to.",
      "- The admin area is limited to instance administrators.",
      "- Environment variables, backup credentials and deployment snapshots are encrypted at rest.",
    ].join("\n"),
  );
  return out.join("\n\n");
}

function incidentPolicy(f: PolicyFacts): string {
  const i = f.incident;
  const out = [`${f.name} runs on Vardo. This policy describes how problems are surfaced on that platform.`];

  const detection = ["- Vardo checks the certificate on every public domain and raises an alert before it expires."];
  if (i.backupFailureAlerts) detection.push("- A failed backup raises an alert.");
  if (i.email) detection.push("- Alerts can be sent by email.");
  out.push(`## Detection\n${detection.join("\n")}`);

  if (i.securityContact) out.push(`## Reporting\nSecurity problems can be reported to ${i.securityContact}.`);
  if (i.breachNotification) out.push(`## Breach notification\n${f.name}'s breach notification commitment: ${i.breachNotification.toLowerCase()}.`);
  return out.join("\n\n");
}

export function generatePolicy(id: PolicyId, facts: PolicyFacts): string {
  return { backup: backupPolicy, access: accessPolicy, incident: incidentPolicy }[id](facts);
}

/** Stable hash of the settings a policy reads. A new hash means the reviewed text no longer matches. */
export function basisHash(id: PolicyId, facts: PolicyFacts): string {
  const basis = { name: facts.name, ...(facts[id] as object) };
  return createHash("sha256").update(JSON.stringify(basis, Object.keys(basis).sort())).digest("hex").slice(0, 16);
}

export type ReviewState = "draft" | "review" | "reviewed";

/** Draft: never reviewed. Review: settings changed since. The public page keeps the last reviewed text either way. */
export function reviewState(doc: { reviewedAt: Date | null; basisHash: string | null } | null, current: string): ReviewState {
  if (!doc?.reviewedAt) return "draft";
  return doc.basisHash === current ? "reviewed" : "review";
}
