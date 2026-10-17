// Outbound policy for uptime checks. The core takes a fetcher and a host guard; this builds them from Vardo's SSRF policy.

import { lookup } from "node:dns/promises";
import { consoleBaseUrl } from "@/lib/incidents/key";
import { getDomainProbePolicy } from "@/lib/security/outbound-policy";
import { safeFetch } from "@/lib/security/safe-fetch";
import { alwaysBlockedReason, blockedAddressReason, isAllowlisted, parseIPv4, parseIPv6, type OutboundPolicy } from "@/lib/security/ssrf";
import { checkHost, type Check, type HostGuard } from "./core";
import { isPrivateOrMesh } from "./net";

/** Strict refuses private, loopback, link-local and mesh addresses outright. Operator follows the domain-probe policy, with its allowlist. */
export type PolicyLevel = "strict" | "operator";

export type CheckDeps = { fetch: typeof fetch; guard: HostGuard };

const isLiteral = (host: string) => !!(parseIPv4(host) || parseIPv6(host));

async function policyFor(level: PolicyLevel): Promise<OutboundPolicy> {
  if (level === "strict") return {};
  const policy = await getDomainProbePolicy();
  try {
    return { allowlist: [...(policy.allowlist ?? []), new URL(consoleBaseUrl()).hostname] };
  } catch {
    return policy;
  }
}

/** Why a host may not be reached under this policy, or null. A name that doesn't resolve is allowed; it fails when checked. */
export async function blockedHostReason(host: string, policy: OutboundPolicy, level: PolicyLevel): Promise<string | null> {
  const name = host.replace(/^\[|\]$/g, "");
  if (!name) return "Enter a host.";
  const allowed = isAllowlisted(name, policy.allowlist);
  let addresses: string[];
  if (isLiteral(name)) addresses = [name];
  else {
    try {
      addresses = (await lookup(name, { all: true })).map((a) => a.address);
    } catch {
      return null;
    }
  }
  for (const address of addresses) {
    const always = alwaysBlockedReason(address);
    if (always) return `${name} resolves to ${address} (${always})`;
    if (allowed) continue;
    const reason = blockedAddressReason(address) ?? (level === "strict" && isPrivateOrMesh(address) ? "private or mesh address" : null);
    if (reason) return `${name} resolves to ${address} (${reason})`;
  }
  return null;
}

/** The fetcher and host guard checks run through. Redirects are vetted per hop and sockets connect only to allowed addresses. */
export async function checkDeps(level: PolicyLevel): Promise<CheckDeps> {
  const policy = await policyFor(level);
  return {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      try {
        return await safeFetch(String(input instanceof Request ? input.url : input), { ...init, policy });
      } catch (err) {
        if (err instanceof Error && err.name === "BlockedUrlError" && /^Could not resolve/.test(err.message)) {
          throw Object.assign(new Error(err.message), { code: "ENOTFOUND" });
        }
        throw err;
      }
    }) as typeof fetch,
    guard: (host) => blockedHostReason(host, policy, level),
  };
}

/** The reason a monitor's target is refused for this level, or null. Used when a monitor is created or edited. */
export async function targetRefusal(check: Check, level: PolicyLevel): Promise<string | null> {
  return blockedHostReason(checkHost(check), await policyFor(level), level);
}

/** Which policy a monitor runs under: manual org monitors are strict; automatic and instance monitors follow the operator policy. */
export const levelOf = (m: { organizationId: string | null; source: string }): PolicyLevel =>
  m.organizationId && m.source !== "auto" ? "strict" : "operator";
