// Who may route a hostname (#891): refused hosts, DNS TXT challenges and what a verified zone covers.

import { randomBytes } from "crypto";
import { Resolver } from "dns/promises";

export const CHALLENGE_PREFIX = "_vardo-challenge";

export function newChallengeToken(): string {
  return `vardo-${randomBytes(16).toString("hex")}`;
}

export function challengeName(host: string): string {
  return `${CHALLENGE_PREFIX}.${host.toLowerCase()}`;
}

export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isUnder(host: string, zone: string): boolean {
  return host.toLowerCase().endsWith(`.${zone.toLowerCase()}`);
}

export type InstanceHosts = {
  /** The instance base domain, lowercase. */
  base: string | null;
  /** The console's own hostnames, lowercase. */
  console: string[];
};

/** The console's hostnames from instance config, `VARDO_DOMAIN` and the auth URLs. */
export function consoleHostsFrom(instanceDomain: string | undefined | null): string[] {
  const hosts = [
    instanceDomain,
    process.env.VARDO_DOMAIN,
    hostOf(process.env.NEXT_PUBLIC_BETTER_AUTH_URL),
    hostOf(process.env.BETTER_AUTH_URL),
  ];
  return [...new Set(hosts.filter((h): h is string => !!h).map((h) => h.toLowerCase()))];
}

/** Why a host can't be registered by any org, or null. */
export function refusedHost(host: string, inst: InstanceHosts): string | null {
  const h = host.toLowerCase();
  if (inst.console.includes(h)) return "That's the console's own host.";
  if (inst.base && h === inst.base) return "That's the instance base domain. Use a subdomain instead.";
  return null;
}

export type Trust = { trusted: boolean };

/** Whether a host outside the org's verified zones needs a TXT challenge before it counts. */
export function needsChallenge(host: string, inst: InstanceHosts, org: Trust): boolean {
  if (org.trusted) return false;
  return !(inst.base && isUnder(host, inst.base));
}

/** A zone the org verified, or any zone for trusted orgs, that contains the host. */
export function coveredByZone(host: string, zones: string[]): boolean {
  const h = host.toLowerCase();
  return zones.some((z) => h === z.toLowerCase() || isUnder(h, z));
}

export type RowProof = { domain: string; verifiedAt: Date | null };

/** Whether the row may route or count as owned. */
export function isRoutable(row: RowProof, inst: InstanceHosts, org: Trust, verifiedZones: string[]): boolean {
  if (refusedHost(row.domain, inst)) return false;
  if (!needsChallenge(row.domain, inst, org)) return true;
  return row.verifiedAt !== null || coveredByZone(row.domain, verifiedZones);
}

export type TxtResolver = (name: string) => Promise<string[][]>;

export type ChallengeResult =
  | { status: "verified" }
  | { status: "missing"; found: string[] }
  | { status: "error" };

const NO_RECORD = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

function defaultResolver(): TxtResolver {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  return (name) => resolver.resolveTxt(name);
}

/** Looks for the token in TXT records at `_vardo-challenge.<host>`. A failed lookup is "error", not "missing". */
export async function checkChallenge(
  host: string,
  token: string,
  resolveTxt: TxtResolver = defaultResolver(),
): Promise<ChallengeResult> {
  try {
    const records = (await resolveTxt(challengeName(host))).map((chunks) => chunks.join("").trim());
    return records.includes(token) ? { status: "verified" } : { status: "missing", found: records };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code && NO_RECORD.has(code) ? { status: "missing", found: [] } : { status: "error" };
  }
}

export type VerificationView = {
  state: "not-required" | "verified" | "pending";
  verifiedAt: Date | null;
  recordName: string;
  recordValue: string | null;
};

export function verificationView(
  row: RowProof & { verificationToken: string | null },
  inst: InstanceHosts,
  org: Trust,
  verifiedZones: string[],
): VerificationView {
  const base = { verifiedAt: row.verifiedAt, recordName: challengeName(row.domain), recordValue: row.verificationToken };
  if (!needsChallenge(row.domain, inst, org)) return { ...base, state: "not-required" };
  const verified = row.verifiedAt !== null || coveredByZone(row.domain, verifiedZones);
  return { ...base, state: verified ? "verified" : "pending" };
}
