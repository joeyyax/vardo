// What the public trust page may show. toPublic is the one approval filter: the page reads nothing else.

import { findProvider, judgeProviderCert, locationLabel, type Hosting } from "./hosting";
import type { CheckId, CheckResult } from "./types";

export type ControlGroup = "Data protection" | "Access" | "Network and platform";

/** Passing checks become these outcomes. A check missing here never shows publicly. */
export const PUBLIC_CONTROLS: Partial<Record<CheckId, { group: ControlGroup; outcome: string }>> = {
  "nightly-backups": { group: "Data protection", outcome: "Nightly backups completing" },
  "backups-protected": { group: "Data protection", outcome: "Backups encrypted and stored off the host" },
  "restore-tested": { group: "Data protection", outcome: "Backups restore-tested within the past 7 days" },
  "disk-encrypted": { group: "Data protection", outcome: "Host disk encrypted" },
  "two-step": { group: "Access", outcome: "Two-step sign-in for every member" },
  "security-contact": { group: "Access", outcome: "Security contact published" },
  https: { group: "Network and platform", outcome: "Valid HTTPS certificates on every public domain" },
  "probe-guard": { group: "Network and platform", outcome: "Automated blocking of probing traffic" },
  "vardo-updated": { group: "Network and platform", outcome: "Platform up to date" },
};

const GROUP_ORDER: ControlGroup[] = ["Data protection", "Access", "Network and platform"];

export type CommitmentInput = { label: string; value: string | null; enabled: boolean };
export type SubprocessorInput = { name: string; purpose: string; region: string | null; status: "suggested" | "confirmed" | "dismissed" };
export type PolicyInput = { id: string; title: string; reviewedBody: string | null; reviewedAt: Date | null };
export type DpaInput = { reviewedAt: Date | null; hasFile: boolean };

export type PublicInput = {
  name: string;
  securityContact: string | null;
  hosting: Hosting | null;
  results: CheckResult[];
  commitments: CommitmentInput[];
  subprocessors: SubprocessorInput[];
  policies: PolicyInput[];
  dpa: DpaInput | null;
};

export type PublicTrust = {
  name: string;
  securityContact: string | null;
  hosting: {
    provider: string;
    location: string | null;
    certification: { standard: string; url: string } | null;
  } | null;
  controls: { group: ControlGroup; items: { outcome: string; checkedAt: Date }[] }[];
  commitments: { label: string; value: string }[];
  subprocessors: { name: string; purpose: string; region: string | null }[];
  policies: { id: string; title: string; body: string; reviewedAt: Date }[];
  dpa: { reviewedAt: Date } | null;
};

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Keeps only what the operator has approved and what passes. */
export function toPublic(input: PublicInput): PublicTrust {
  const provider = input.hosting ? findProvider(input.hosting.provider) : null;
  const cert = input.hosting && provider && judgeProviderCert(input.hosting).state === "passing" ? provider.certification : null;

  const groups = new Map<ControlGroup, { outcome: string; checkedAt: Date }[]>();
  for (const r of input.results) {
    const def = PUBLIC_CONTROLS[r.id];
    if (!def || r.state !== "passing" || !r.checkedAt) continue;
    groups.set(def.group, [...(groups.get(def.group) ?? []), { outcome: def.outcome, checkedAt: r.checkedAt }]);
  }

  return {
    name: input.name,
    securityContact: input.securityContact && EMAIL_RE.test(input.securityContact) ? input.securityContact : null,
    hosting: input.hosting
      ? {
          provider: provider?.name ?? input.hosting.provider,
          location: locationLabel(provider, input.hosting),
          certification: cert ? { standard: cert.standard, url: cert.url } : null,
        }
      : null,
    controls: GROUP_ORDER.filter((g) => groups.has(g)).map((group) => ({ group, items: groups.get(group)! })),
    commitments: input.commitments.flatMap((c) => (c.enabled && c.value ? [{ label: c.label, value: c.value }] : [])),
    subprocessors: input.subprocessors.filter((s) => s.status === "confirmed").map(({ name, purpose, region }) => ({ name, purpose, region })),
    policies: input.policies.flatMap((p) => (p.reviewedAt && p.reviewedBody ? [{ id: p.id, title: p.title, body: p.reviewedBody, reviewedAt: p.reviewedAt }] : [])),
    dpa: input.dpa?.hasFile && input.dpa.reviewedAt ? { reviewedAt: input.dpa.reviewedAt } : null,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "checked 2 hours ago". */
export function checkedAgo(at: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - at.getTime());
  if (ms < MINUTE) return "checked just now";
  const [n, unit] = ms < HOUR ? [Math.floor(ms / MINUTE), "minute"] : ms < DAY ? [Math.floor(ms / HOUR), "hour"] : [Math.floor(ms / DAY), "day"];
  return `checked ${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

export type Exposure = { label: string; items: string[] }[];

/** What a publish would put on the page, grouped for the confirmation. */
export function exposureOf(t: PublicTrust): Exposure {
  return [
    { label: "Name", items: [t.name] },
    {
      label: "Hosting",
      items: t.hosting
        ? [[t.hosting.provider, t.hosting.location].filter(Boolean).join(", "), ...(t.hosting.certification ? [`Certified to ${t.hosting.certification.standard}, with a link`] : [])]
        : [],
    },
    { label: "Controls", items: t.controls.flatMap((g) => g.items.map((i) => i.outcome)) },
    { label: "Commitments", items: t.commitments.map((c) => `${c.label}: ${c.value}`) },
    { label: "Documents", items: [...t.policies.map((p) => p.title), ...(t.dpa ? ["Data processing agreement"] : [])] },
    { label: "Subprocessors", items: t.subprocessors.map((s) => s.name) },
    { label: "Security contact", items: t.securityContact ? [t.securityContact] : [] },
  ];
}
