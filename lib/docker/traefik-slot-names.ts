// Per-slot Traefik names, so blue and green never define one router two ways during the overlap (#904).

import type { ComposeFile, ComposeService } from "./compose-types";

type Labels = Record<string, string>;

const OBJECT_LABEL = /^traefik\.(http|tcp)\.(routers|services|middlewares)\.([^.]+)\.(.+)$/i;

type Declared = Record<string, Set<string>>;

/** `http.services`-style key for the declared-name sets. */
function kindKey(protocol: string, kind: string): string {
  return `${protocol.toLowerCase()}.${kind.toLowerCase()}`;
}

/** Rewrites `name` or `name@docker` to its slot name when this app declares it. */
function renameRef(ref: string, names: Set<string> | undefined, slot: string): string {
  const trimmed = ref.trim();
  const [name, provider] = trimmed.split("@");
  if (!names?.has(name) || (provider !== undefined && provider !== "docker")) return trimmed;
  return provider ? `${name}-${slot}@${provider}` : `${name}-${slot}`;
}

function renameList(value: string, names: Set<string> | undefined, slot: string): string {
  return value
    .split(",")
    .map((ref) => renameRef(ref, names, slot))
    .join(",");
}

function slotLabels(labels: Labels, declared: Declared, slot: string): Labels {
  const out: Labels = {};
  const routers = new Map<string, { protocol: string; hasService: boolean }>();
  const ownServices: Record<string, string[]> = {};

  for (const [key, value] of Object.entries(labels)) {
    const match = OBJECT_LABEL.exec(key);
    if (!match) {
      out[key] = value;
      continue;
    }
    const [, protocol, kind, name, rest] = match;
    const prefix = key.slice(0, key.length - name.length - rest.length - 1);
    const slotKey = `${prefix}${name}-${slot}.${rest}`;
    const option = rest.toLowerCase();

    if (kind.toLowerCase() === "routers") {
      const router = routers.get(name) ?? { protocol, hasService: false };
      let next = value;
      if (option === "service") {
        router.hasService = true;
        next = renameRef(value, declared[kindKey(protocol, "services")], slot);
      } else if (option === "middlewares") {
        next = renameList(value, declared[kindKey(protocol, "middlewares")], slot);
      }
      routers.set(name, router);
      out[slotKey] = next;
      continue;
    }

    // Services and middlewares keep their own name too; other apps and the file provider reference it.
    out[key] = value;
    if (kind.toLowerCase() === "services") {
      const list = (ownServices[protocol.toLowerCase()] ??= []);
      if (!list.includes(name)) list.push(name);
      out[slotKey] = value;
    } else {
      out[slotKey] =
        option === "chain.middlewares"
          ? renameList(value, declared[kindKey(protocol, "middlewares")], slot)
          : value;
    }
  }

  // A router without a service took the container's only one; the alias makes that two.
  for (const [name, router] of routers) {
    const services = ownServices[router.protocol.toLowerCase()] ?? [];
    if (router.hasService || services.length !== 1) continue;
    out[`traefik.${router.protocol}.routers.${name}-${slot}.service`] = `${services[0]}-${slot}`;
  }

  return out;
}

/**
 * Suffix the slot onto every HTTP and TCP router, service and middleware the rotating services declare.
 * Routers are renamed outright; services and middlewares gain a slot copy and keep the original.
 */
export function slotTraefikNames(
  compose: ComposeFile,
  slot: string,
  opts: {
    shared?: Set<string>;
    /** The compose whose declarations references resolve against. Defaults to `compose`. */
    declaredIn?: ComposeFile;
  } = {},
): ComposeFile {
  const shared = opts.shared ?? new Set<string>();
  const rotating = Object.entries(compose.services).filter(
    ([name, svc]) => !shared.has(name) && svc.labels,
  );

  const declared: Declared = {};
  for (const [name, svc] of Object.entries((opts.declaredIn ?? compose).services)) {
    if (shared.has(name)) continue;
    for (const key of Object.keys(svc.labels ?? {})) {
      const match = OBJECT_LABEL.exec(key);
      if (!match) continue;
      (declared[kindKey(match[1], match[2])] ??= new Set()).add(match[3]);
    }
  }
  if (rotating.length === 0 || Object.keys(declared).length === 0) return compose;

  const services: Record<string, ComposeService> = { ...compose.services };
  for (const [name, svc] of rotating) {
    services[name] = { ...svc, labels: slotLabels(svc.labels!, declared, slot) };
  }
  return { ...compose, services };
}

/** The full compose and the bare file a slot writes, with per-slot Traefik names on blue and green. */
export function slotComposePair(
  compose: ComposeFile,
  bare: ComposeFile,
  slot: string,
  shared: Set<string>,
): { full: ComposeFile; bare: ComposeFile } {
  if (slot !== "blue" && slot !== "green") return { full: compose, bare };
  return {
    full: slotTraefikNames(compose, slot, { shared }),
    bare: slotTraefikNames(bare, slot, { shared, declaredIn: compose }),
  };
}
