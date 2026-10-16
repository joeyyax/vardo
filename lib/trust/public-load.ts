// Loads the approved page for the chosen domain and keeps the rendered HTML for a minute.

import { getInstanceDisplayName } from "@/lib/system-settings";
import { getProbeGuardSettings } from "@/lib/probe-guard/instance";
import { readCommitments } from "./commitment-facts";
import { isTrustHost } from "./domains";
import { renderTrustPage } from "./page";
import { toPublic, type PublicInput } from "./public";
import { effectiveHosting, getTrustSettings, readResults } from "./store";

const TTL_MS = 60_000;

/** Everything the page may show, before the approval filter. */
export async function loadPublicInput(): Promise<PublicInput> {
  const settings = await getTrustSettings();
  const [results, instanceName, guard, commitments] = await Promise.all([
    readResults(),
    getInstanceDisplayName().catch(() => null),
    getProbeGuardSettings().catch(() => null),
    readCommitments(),
  ]);
  return {
    name: settings.name ?? instanceName ?? "This operator",
    domain: settings.domain ?? "",
    securityContact: guard?.securityContact?.trim() || null,
    hosting: effectiveHosting(settings),
    results,
    commitments: commitments.map((c) => ({ label: c.label, value: c.value, enabled: c.enabled })),
    subprocessors: [],
    policies: [],
    dpa: null,
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

/** The page for a request to `host`, or null unless the page is public and `host` is its domain. */
export async function servePublicTrust(host: string | null, now = new Date()): Promise<string | null> {
  const snap = await snapshot(now);
  return snap.html && isTrustHost(host, snap.domain) ? snap.html : null;
}

/** The page as it would publish, for an admin preview: ignores visibility and the domain. */
export async function renderPreview(now = new Date()): Promise<string> {
  return renderTrustPage(toPublic(await loadPublicInput()), now);
}
