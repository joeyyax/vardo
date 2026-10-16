// Loads the approved page for the chosen domain and keeps the rendered HTML for a minute.

import { getProbeGuardSettings } from "@/lib/probe-guard/instance";
import { readCommitments } from "./commitment-facts";
import { readPublicDocuments } from "./documents";
import { isTrustHost } from "./domains";
import { renderTrustPage } from "./page";
import { readSubprocessors } from "./subprocessor-store";
import { toPublic, type PublicInput } from "./public";
import { effectiveHosting, getTrustSettings, readResults } from "./store";

const TTL_MS = 60_000;

/** Everything the page may show, before the approval filter. */
export async function loadPublicInput(): Promise<PublicInput> {
  const settings = await getTrustSettings();
  const [results, guard, commitments, subprocessors, documents] = await Promise.all([
    readResults(),
    getProbeGuardSettings().catch(() => null),
    readCommitments(),
    readSubprocessors(),
    readPublicDocuments(),
  ]);
  return {
    name: settings.name ?? "This operator",
    domain: settings.domain ?? "",
    securityContact: guard?.securityContact?.trim() || null,
    hosting: effectiveHosting(settings),
    results,
    commitments: commitments.map((c) => ({ label: c.label, value: c.value, enabled: c.enabled })),
    subprocessors: subprocessors.map(({ name, purpose, region, status }) => ({ name, purpose, region, status })),
    policies: documents.policies,
    dpa: documents.dpa,
  };
}

type Cached = { at: number; domain: string | null; html: string | null };
let cached: Cached | null = null;

/** Called after any admin change so the public page doesn't lag. */
export function invalidatePublicTrust(): void {
  cached = null;
}

async function snapshot(now: Date): Promise<Cached> {
  if (cached && now.getTime() - cached.at < TTL_MS) return cached;
  const settings = await getTrustSettings();
  const live = settings.visibility === "public" && settings.domain;
  const html = live ? renderTrustPage(toPublic(await loadPublicInput()), now) : null;
  cached = { at: now.getTime(), domain: settings.domain, html };
  return cached;
}

/** True when the page is public and `host` is its domain. */
export async function isPublicOn(host: string | null, now = new Date()): Promise<boolean> {
  const snap = await snapshot(now);
  return !!snap.html && isTrustHost(host, snap.domain);
}

/** The page for a request to `host`, or null unless the page is public and `host` is its domain. */
export async function servePublicTrust(host: string | null, now = new Date()): Promise<string | null> {
  const snap = await snapshot(now);
  return snap.html && isTrustHost(host, snap.domain) ? snap.html : null;
}

/** The page as it would publish, for an admin preview: ignores visibility and the domain. */
export async function renderPreview(now = new Date()): Promise<string> {
  return renderTrustPage(toPublic(await loadPublicInput()), now);
}
