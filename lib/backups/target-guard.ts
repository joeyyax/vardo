// Where an org's backup targets may point: S3 endpoints and SSH hosts pass the SSRF policy, local paths stay under a root.

import { realpath } from "fs/promises";
import { isAbsolute, join, resolve, sep } from "path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getOutboundPolicy } from "@/lib/security/outbound-policy";
import { guardedLookup } from "@/lib/security/pinned-fetch";
import {
  alwaysBlockedReason,
  assertOutboundUrlAllowed,
  BlockedUrlError,
  isAllowlisted,
  parseIPv4,
  parseIPv6,
} from "@/lib/security/ssrf";

export class TargetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetRefusedError";
  }
}

export type TargetGuardContext = {
  /** Null for instance targets, which only instance admins manage. */
  organizationId: string | null;
  trusted: boolean;
  instanceAdmin: boolean;
};

async function orgTrusted(organizationId: string): Promise<boolean> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { trusted: true },
  });
  return org?.trusted === true;
}

export async function targetGuardContext(organizationId: string | null, instanceAdmin: boolean): Promise<TargetGuardContext> {
  return {
    organizationId,
    trusted: organizationId ? await orgTrusted(organizationId) : true,
    instanceAdmin,
  };
}

/** Whether this target's host may resolve to a private address. Link-local stays refused regardless. */
export async function targetMayReachPrivate(organizationId: string | null | undefined, hostname: string): Promise<boolean> {
  if (!organizationId) return true;
  if (await orgTrusted(organizationId)) return true;
  return isAllowlisted(hostname, (await getOutboundPolicy()).allowlist);
}

async function assertHostAllowed(organizationId: string | null, url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new TargetRefusedError(`Not a valid URL: ${url}`);
  }
  const allowPrivate = await targetMayReachPrivate(organizationId, host);
  try {
    await assertOutboundUrlAllowed(url, allowPrivate ? { allowlist: [host] } : await getOutboundPolicy());
  } catch (err) {
    if (err instanceof BlockedUrlError) throw new TargetRefusedError(err.message);
    throw err;
  }
}

/** Refuses an S3 endpoint the org may not reach. */
export async function assertS3EndpointAllowed(organizationId: string | null, endpoint: string): Promise<void> {
  await assertHostAllowed(organizationId, endpoint);
}

/** Local target roots: VARDO_LOCAL_BACKUP_ROOTS (comma separated), else <VARDO_HOME_DIR>/backups. */
export function localBackupRoots(): string[] {
  const raw = process.env.VARDO_LOCAL_BACKUP_ROOTS?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  if (raw.length > 0) return raw.map((r) => resolve(r));
  const home = process.env.VARDO_HOME_DIR || process.env.VARDO_DIR;
  return [resolve(home ? join(home, "backups") : "./.host/local-backups")];
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Refuses a local path outside the configured roots, before or after resolving symlinks. */
export async function assertLocalPathAllowed(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TargetRefusedError("Local backup path must be absolute");
  if (path.split(/[\\/]/).includes("..")) throw new TargetRefusedError("Local backup path can't contain '..'");
  const normalized = resolve(path);
  const roots = localBackupRoots();
  const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  if (!roots.some((root) => within(normalized, root))) {
    throw new TargetRefusedError(`Local backup path must be inside ${roots.join(" or ")}`);
  }
  const real = await realOrSelf(normalized);
  const realRoots = await Promise.all(roots.map(realOrSelf));
  if (!realRoots.some((root) => within(real, root))) {
    throw new TargetRefusedError(`Local backup path must be inside ${roots.join(" or ")}`);
  }
  return normalized;
}

/** Throws TargetRefusedError when an org may not save this target config. */
export async function assertTargetAllowed(
  type: string,
  config: Record<string, unknown>,
  ctx: TargetGuardContext,
): Promise<void> {
  if (ctx.organizationId === null) return;

  if ((type === "s3" || type === "r2" || type === "b2") && typeof config.endpoint === "string" && config.endpoint) {
    await assertS3EndpointAllowed(ctx.organizationId, config.endpoint);
  }

  if (type === "ssh" && typeof config.host === "string") {
    const host = parseIPv6(config.host) ? `[${config.host}]` : config.host;
    await assertHostAllowed(ctx.organizationId, `https://${host}`);
  }

  if (type === "local") {
    if (!ctx.trusted && !ctx.instanceAdmin) {
      throw new TargetRefusedError("Local backup targets need a trusted organization or an instance admin");
    }
    if (typeof config.path !== "string") throw new TargetRefusedError("Path is required");
    await assertLocalPathAllowed(config.path);
  }
}

/** A dns lookup for an org S3 client: refuses private addresses unless the org may reach them. */
export function backupEndpointLookup(organizationId: string | null | undefined) {
  return (hostname: string, options: object, callback: (...args: unknown[]) => void): void => {
    targetMayReachPrivate(organizationId, hostname).then(
      (allow) => guardedLookup(allow)(hostname, options as never, callback as never),
      (err) => callback(err, []),
    );
  };
}

/** Request-time check for an endpoint; covers literal IPs, which skip the lookup. */
export async function assertEndpointReachable(organizationId: string | null | undefined, endpoint: string): Promise<void> {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  if (parseIPv4(host) || parseIPv6(host)) {
    const always = alwaysBlockedReason(host);
    if (always) throw new BlockedUrlError(`Refusing to reach ${host} — ${always}`);
  }
  if (!organizationId) return;
  await assertS3EndpointAllowed(organizationId, endpoint).catch((err) => {
    throw err instanceof TargetRefusedError ? new BlockedUrlError(err.message) : err;
  });
}
