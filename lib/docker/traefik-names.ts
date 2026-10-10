// Namespaces the Traefik routers, services and middlewares a tenant compose declares to its app.

import type { ComposeFile, ComposeService } from "./compose-types";
import { VARDO_MIDDLEWARES } from "@/lib/domains/middlewares";
import { interpolate } from "./compose-hosts";

const OBJECT_LABEL = /^(traefik\.(http|tcp|udp)\.(routers|services|middlewares)\.)([^.]+)(\..+)$/i;

type Kind = "routers" | "services" | "middlewares";

/** Declared names keyed `protocol.kind`, e.g. `http.middlewares`. */
type Declared = Map<string, Set<string>>;

export type NamespaceResult = {
  compose: ComposeFile;
  /** Original name to namespaced name, for the deploy log. */
  renamed: Map<string, string>;
  /** References to objects the app doesn't declare. Refused for untrusted organizations. */
  foreignRefs: string[];
};

/** The prefix every name in this app's compose carries. */
export function traefikNamePrefix(appId: string): string {
  return appId.toLowerCase();
}

function namespaced(name: string, prefix: string): string {
  return name.toLowerCase().startsWith(`${prefix}-`) ? name : `${prefix}-${name}`;
}

function collectDeclared(compose: ComposeFile): Declared {
  const declared: Declared = new Map();
  for (const svc of Object.values(compose.services)) {
    for (const key of Object.keys(svc.labels ?? {})) {
      const m = OBJECT_LABEL.exec(key);
      if (!m) continue;
      const k = `${m[2].toLowerCase()}.${m[3].toLowerCase()}`;
      if (!declared.has(k)) declared.set(k, new Set());
      declared.get(k)!.add(m[4]);
    }
  }
  return declared;
}

/** What kind of object an option's value references, if any. */
function refKind(kind: Kind, option: string): { kind: Kind; list: boolean } | null {
  const o = option.toLowerCase();
  if (kind === "routers" && o === ".service") return { kind: "services", list: false };
  if (kind === "routers" && o === ".middlewares") return { kind: "middlewares", list: true };
  if (kind === "middlewares" && o === ".chain.middlewares") return { kind: "middlewares", list: true };
  if (kind === "middlewares" && o === ".errors.service") return { kind: "services", list: false };
  return null;
}

/**
 * Rewrites declared names to `<prefix>-<name>` and the references to them.
 * Names Vardo injects later are untouched; run this before injection.
 */
export function namespaceTraefikNames(
  compose: ComposeFile,
  appId: string,
  opts: { trusted: boolean; appEnv?: Record<string, string>; shellEnv?: Record<string, string | undefined> },
): NamespaceResult {
  const prefix = traefikNamePrefix(appId);
  const declared = collectDeclared(compose);
  const renamed = new Map<string, string>();
  const foreignRefs = new Set<string>();

  // A variable reference is checked as Compose will resolve it.
  const rewriteValue = (value: string, protocol: string, ref: { kind: Kind; list: boolean }): string => {
    let resolved = value;
    if (value.replaceAll("$$", "").includes("$")) {
      const out = interpolate(value, opts.appEnv ?? {}, opts.shellEnv ?? {});
      if ("error" in out) {
        if (!opts.trusted) foreignRefs.add(value);
        return value;
      }
      resolved = out.value;
    }
    const next = ref.list
      ? resolved.split(",").map((r) => rewriteRef(r, protocol, ref.kind)).filter(Boolean).join(",")
      : rewriteRef(resolved, protocol, ref.kind);
    if (resolved === value) return next;
    // Escaped, so Compose doesn't interpolate the rewritten value again.
    return next !== resolved ? next.split("$").join("$$") : value;
  };

  const rewriteRef = (ref: string, protocol: string, kind: Kind): string => {
    const trimmed = ref.trim();
    if (!trimmed) return trimmed;
    const at = trimmed.indexOf("@");
    const name = at === -1 ? trimmed : trimmed.slice(0, at);
    const provider = at === -1 ? null : trimmed.slice(at + 1).toLowerCase();
    if (provider === null || provider === "docker") {
      if (declared.get(`${protocol}.${kind}`)?.has(name)) {
        const next = namespaced(name, prefix);
        return provider ? `${next}@${provider}` : next;
      }
      if (!name.toLowerCase().startsWith(`${prefix}-`)) foreignRefs.add(trimmed);
      return trimmed;
    }
    // Other providers hold Vardo's and other apps' objects; untrusted orgs get Vardo's middlewares only.
    if (!opts.trusted && !(kind === "middlewares" && VARDO_MIDDLEWARES.has(trimmed))) foreignRefs.add(trimmed);
    return trimmed;
  };

  const services: Record<string, ComposeService> = {};
  for (const [svcName, svc] of Object.entries(compose.services)) {
    if (!svc.labels) {
      services[svcName] = svc;
      continue;
    }
    const labels: Record<string, string> = {};
    for (const [key, raw] of Object.entries(svc.labels)) {
      const value = String(raw);
      const m = OBJECT_LABEL.exec(key);
      if (!m) {
        labels[key] = value;
        continue;
      }
      const [, head, protocolRaw, kindRaw, name, option] = m;
      const protocol = protocolRaw.toLowerCase();
      const kind = kindRaw.toLowerCase() as Kind;
      const next = namespaced(name, prefix);
      if (next !== name) renamed.set(name, next);
      const ref = refKind(kind, option);
      labels[`${head}${next}${option}`] = ref ? rewriteValue(value, protocol, ref) : value;
    }
    services[svcName] = { ...svc, labels };
  }

  return { compose: { ...compose, services }, renamed, foreignRefs: [...foreignRefs] };
}
