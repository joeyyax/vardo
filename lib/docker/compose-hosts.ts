// Hostnames a compose file's Traefik router labels claim, judged against what the org owns.

import type { ComposeFile } from "./compose-types";
import {
  parseRule,
  judgeRule,
  type ClaimVerdict,
  type HostClaim,
  type RuleNode,
} from "./traefik-rule";

// Traefik reads label keys case-insensitively.
const RULE_LABEL = /^traefik\.(http|tcp)\.routers\.[^.]+\.rule$/i;

export type LabelRule = {
  service: string;
  label: string;
  /** The label value as written. */
  raw: string;
  /** Parsed after interpolation, or why it couldn't be. */
  parsed: RuleNode | { error: string };
};

type Interpolated = { value: string } | { error: string };

/** Compose-style `${VAR}`, `${VAR:-d}`, `${VAR-d}`, `$VAR` and `$$`. Shell env wins over the app's env, as in Compose. */
export function interpolate(
  raw: string,
  appEnv: Record<string, string>,
  shellEnv: Record<string, string | undefined>,
): Interpolated {
  let failed: string | null = null;
  const lookup = (name: string): string | undefined => shellEnv[name] ?? appEnv[name];
  const value = raw.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\{[^}]*\}?/g,
    (match, name: string | undefined, colon: string, op: string, arg: string, bare: string | undefined) => {
      if (match === "$$") return "$";
      const key = name ?? bare;
      if (!key) {
        failed = `can't read ${match}`;
        return match;
      }
      const v = lookup(key);
      const unset = colon ? !v : v === undefined;
      if (!op) {
        if (v === undefined) failed = `\${${key}} isn't set`;
        return v ?? "";
      }
      if (op === "-") return unset ? arg : v!;
      if (op === "+") return unset ? "" : arg;
      if (unset) failed = `\${${key}} isn't set`;
      return v ?? "";
    },
  );
  if (failed) return { error: failed };
  // An env value still holding a template resolves later in the deploy.
  if (value.includes("${")) return { error: "a variable resolves to another template" };
  return { value };
}

/** Every Traefik router rule label in the compose, parsed. */
export function collectLabelRules(
  compose: ComposeFile,
  appEnv: Record<string, string> = {},
  shellEnv: Record<string, string | undefined> = {},
): LabelRule[] {
  const out: LabelRule[] = [];
  for (const [service, svc] of Object.entries(compose.services)) {
    for (const [label, rawValue] of Object.entries(svc.labels ?? {})) {
      if (!RULE_LABEL.test(label)) continue;
      const raw = String(rawValue ?? "");
      const interpolated = raw.includes("$") ? interpolate(raw, appEnv, shellEnv) : { value: raw };
      let parsed: LabelRule["parsed"];
      if ("error" in interpolated) {
        parsed = { error: interpolated.error };
      } else {
        try {
          parsed = parseRule(interpolated.value);
        } catch (err) {
          parsed = { error: `can't parse the rule: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      out.push({ service, label, raw, parsed });
    }
  }
  return out;
}

/** Hosts and zones the rules name, for loading ownership. */
export function claimedNames(rules: LabelRule[]): { hosts: string[]; zones: string[] } {
  const hosts = new Set<string>();
  const zones = new Set<string>();
  const walk = (n: RuleNode) => {
    if (n.op === "claims") {
      for (const c of n.claims) {
        if (c.kind === "host") hosts.add(c.host);
        if (c.kind === "zone") zones.add(c.zone);
      }
    } else if (n.op === "not") walk(n.node);
    else { walk(n.left); walk(n.right); }
  };
  for (const r of rules) if (!("error" in r.parsed)) walk(r.parsed);
  return { hosts: [...hosts], zones: [...zones] };
}

/** What the deploying org may route. */
export type HostOwnership = {
  trusted: boolean;
  /** Exact hosts: the org's domain rows, environment domains and this deploy's own domains. */
  ownedHosts: Set<string>;
  /** Zones the org holds outright, with every subdomain. */
  ownedZones: string[];
  /** Hosts another org or the console holds. */
  foreignHosts: Set<string>;
  /** Instance base domain; `<app>.<base>` and `<app>-*.<base>` go to the org whose app name prefixes it. */
  instanceBase: string | null;
  /** Top-level app name to its org ID, for names that prefix a claimed host. */
  appNameOrgs: Map<string, string>;
  orgId: string;
};

const under = (host: string, zone: string) => host === zone || host.endsWith(`.${zone}`);

/** The app whose name is the longest prefix of a host's first label on the instance base domain. */
function nameOwner(host: string, o: HostOwnership): string | null {
  if (!o.instanceBase || !host.endsWith(`.${o.instanceBase}`)) return null;
  const label = host.slice(0, -(o.instanceBase.length + 1));
  if (label.includes(".")) return null;
  let best: string | null = null;
  for (const name of o.appNameOrgs.keys()) {
    if ((label === name || label.startsWith(`${name}-`)) && (!best || name.length > best.length)) best = name;
  }
  return best ? o.appNameOrgs.get(best)! : null;
}

/** Candidate app names for a host on the instance base: each `-` prefix of its first label. */
export function nameCandidates(host: string, instanceBase: string | null): string[] {
  if (!instanceBase || !host.endsWith(`.${instanceBase}`)) return [];
  const label = host.slice(0, -(instanceBase.length + 1));
  if (label.includes(".")) return [];
  const parts = label.split("-");
  return parts.map((_, i) => parts.slice(0, i + 1).join("-"));
}

export function judgeClaim(claim: HostClaim, o: HostOwnership): ClaimVerdict {
  switch (claim.kind) {
    case "any":
      return "any";
    case "unknown":
      return "uncertain";
    case "host": {
      const h = claim.host;
      if (o.foreignHosts.has(h)) return "foreign";
      // Domain rows are unique instance-wide, so a row of this org's settles it.
      if (o.ownedHosts.has(h)) return "owned";
      const owner = nameOwner(h, o);
      if (owner && owner !== o.orgId) return "foreign";
      if (owner === o.orgId || o.ownedZones.some((z) => under(h, z))) return "owned";
      return "unowned";
    }
    case "zone": {
      const z = claim.zone;
      for (const f of o.foreignHosts) if (under(f, z)) return "foreign";
      // The instance base holds every org's generated hosts.
      if (o.instanceBase && under(o.instanceBase, z)) return "foreign";
      return o.ownedZones.some((oz) => under(z, oz)) ? "owned" : "unowned";
    }
  }
}

export type LabelVerdict = {
  service: string;
  label: string;
  raw: string;
  verdict: ClaimVerdict;
  claims: { claim: HostClaim; verdict: ClaimVerdict }[];
  /** Set when the rule couldn't be read. */
  error?: string;
  /** Whether the deploy goes ahead with this label. */
  allowed: boolean;
};

/** Judges every rule. Uncertain rules pass only for trusted orgs. */
export function judgeLabelRules(rules: LabelRule[], o: HostOwnership): LabelVerdict[] {
  return rules.map((r) => {
    if ("error" in r.parsed) {
      return { service: r.service, label: r.label, raw: r.raw, verdict: "uncertain", claims: [], error: r.parsed.error, allowed: o.trusted };
    }
    const judged = judgeRule(r.parsed, (c) => judgeClaim(c, o));
    const allowed = judged.verdict === "owned" || (judged.verdict === "uncertain" && o.trusted);
    return { service: r.service, label: r.label, raw: r.raw, ...judged, allowed };
  });
}

function describe(c: HostClaim): string {
  switch (c.kind) {
    case "host": return `"${c.host}"`;
    case "zone": return `every subdomain of "${c.zone}"`;
    case "any": return "every hostname";
    case "unknown": return "a host Vardo can't read";
  }
}

/** One line per refused label, for the deploy error. */
export function refusalMessage(v: LabelVerdict): string {
  const where = `Service "${v.service}" label ${v.label}`;
  // Interpolated values can come from the console's environment; never echo them.
  if (v.raw.replaceAll("$$", "").includes("$")) return `${where} (\`${v.raw}\`) claims a host this organization can't use.`;
  if (v.error) return `${where} couldn't be checked (${v.error}). Use Host(\`...\`) with a domain this organization owns.`;
  const bad = v.claims.filter((c) => c.verdict === v.verdict).map((c) => c.claim);
  if (v.verdict === "any") {
    const reason = bad.find((c): c is Extract<HostClaim, { kind: "any" }> => c.kind === "any")?.reason;
    return `${where} matches every hostname${reason ? ` (${reason})` : ""}. Add Host(\`...\`) with a domain this organization owns.`;
  }
  if (v.verdict === "uncertain") {
    const reason = bad.find((c): c is Extract<HostClaim, { kind: "unknown" }> => c.kind === "unknown")?.reason;
    return `${where} couldn't be checked (${reason ?? "unreadable rule"}). Use Host(\`...\`) with a domain this organization owns.`;
  }
  const names = bad.map(describe).join(", ");
  if (v.verdict === "foreign") return `${where} claims ${names}, which is already in use on this instance.`;
  return `${where} claims ${names}, which this organization doesn't own. Add it as a domain on the app or remove the label.`;
}
