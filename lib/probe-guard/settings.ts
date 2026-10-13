// Probe guard settings: per app on the app row, per instance in system_settings.

import { z } from "zod";
import { MAX_EXCEPTIONS, exceptionProblem } from "./rules";

export const WORDPRESS_MODES = ["auto", "on", "off"] as const;

export type AppProbeGuard = {
  enabled: boolean;
  /** Path prefixes the guard leaves alone. */
  exceptions: string[];
  /** "auto" detects WordPress from the image, template or compose file. */
  wordpress: (typeof WORDPRESS_MODES)[number];
  /** Vardo answers /robots.txt with trap lines. Only for apps without their own. */
  robotsTxt: boolean;
};

export const DEFAULT_APP_PROBE_GUARD: AppProbeGuard = { enabled: true, exceptions: [], wordpress: "auto", robotsTxt: false };

const pathListSchema = (max: number) =>
  z
    .array(z.string().trim())
    .max(max)
    .transform((list) => [...new Set(list.filter(Boolean))])
    .superRefine((list, ctx) => {
      for (const p of list) {
        const problem = exceptionProblem(p);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }
    });

export const appProbeGuardSchema = z
  .object({
    enabled: z.boolean(),
    exceptions: pathListSchema(MAX_EXCEPTIONS),
    wordpress: z.enum(WORDPRESS_MODES),
    robotsTxt: z.boolean(),
  })
  .strict();

/** A stored value read defensively; anything malformed falls back to the default. */
export function normalizeAppProbeGuard(raw: unknown): AppProbeGuard {
  if (raw == null) return DEFAULT_APP_PROBE_GUARD;
  const parsed = appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, ...(raw as object) });
  return parsed.success ? parsed.data : DEFAULT_APP_PROBE_GUARD;
}

export const DEFAULT_TRAP_PATHS = ["/admin-backup/", "/.old/", "/private/db.sql"];
export const DECOY_FILE = ".env";
export const MAX_TRAP_PATHS = 20;

export type InstanceProbeGuard = {
  /** Probe hits within the window that ban an address. */
  threshold: number;
  windowMinutes: number;
  /** First ban; each repeat doubles it up to maxBanHours. */
  banMinutes: number;
  maxBanHours: number;
  /** Send new bans to linked instances and apply theirs. */
  shareBans: boolean;
  traps: { enabled: boolean; paths: string[]; decoy: boolean };
  /** Contact in the console's security.txt. Empty falls back to ACME_EMAIL. */
  securityContact: string;
};

export const DEFAULT_INSTANCE_PROBE_GUARD: InstanceProbeGuard = {
  threshold: 5,
  windowMinutes: 10,
  banMinutes: 60,
  maxBanHours: 24,
  shareBans: false,
  traps: { enabled: true, paths: DEFAULT_TRAP_PATHS, decoy: true },
  securityContact: "",
};

export const instanceProbeGuardSchema = z
  .object({
    threshold: z.number().int().min(2).max(100),
    windowMinutes: z.number().int().min(1).max(1440),
    banMinutes: z.number().int().min(5).max(1440),
    maxBanHours: z.number().int().min(1).max(168),
    shareBans: z.boolean(),
    traps: z
      .object({
        enabled: z.boolean(),
        paths: pathListSchema(MAX_TRAP_PATHS),
        decoy: z.boolean(),
      })
      .strict(),
    securityContact: z.union([z.literal(""), z.string().trim().email().max(254)]),
  })
  .strict()
  .refine((s) => s.banMinutes <= s.maxBanHours * 60, { message: "The first ban can't be longer than the longest", path: ["banMinutes"] });

export function normalizeInstanceProbeGuard(raw: unknown): InstanceProbeGuard {
  if (!raw || typeof raw !== "object") return DEFAULT_INSTANCE_PROBE_GUARD;
  const { tarpitMs: _tarpit, humor: _humor, ...r } = raw as Partial<InstanceProbeGuard> & { tarpitMs?: unknown; humor?: unknown };
  const merged = { ...DEFAULT_INSTANCE_PROBE_GUARD, ...r, traps: { ...DEFAULT_INSTANCE_PROBE_GUARD.traps, ...(r.traps ?? {}) } };
  const parsed = instanceProbeGuardSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_INSTANCE_PROBE_GUARD;
}

/** The trap path that serves the decoy file, or null. */
export function decoyPath(settings: InstanceProbeGuard): string | null {
  if (!settings.traps.enabled || !settings.traps.decoy) return null;
  const dir = settings.traps.paths.find((p) => p.endsWith("/"));
  return dir ? `${dir}${DECOY_FILE}` : null;
}

const WORDPRESS_IMAGE = /(?:^|\/)wordpress(?:[:@]|$)/i;
const WORDPRESS_COMPOSE = /^\s*image:\s*["']?(?:\S+\/)?wordpress(?:[:@"'\s]|$)/im;

/** Whether an app looks like WordPress from its image, template or compose file. */
export function detectWordPress(app: {
  imageName?: string | null;
  templateName?: string | null;
  composeContent?: string | null;
  childImages?: readonly (string | null)[];
}): boolean {
  if (app.templateName?.toLowerCase().includes("wordpress")) return true;
  const images = [app.imageName, ...(app.childImages ?? [])].filter((i): i is string => !!i);
  if (images.some((i) => WORDPRESS_IMAGE.test(i))) return true;
  return !!app.composeContent && WORDPRESS_COMPOSE.test(app.composeContent);
}

export function isWordPress(guard: AppProbeGuard, detected: boolean): boolean {
  return guard.wordpress === "on" || (guard.wordpress === "auto" && detected);
}

/** Body for making a ban permanent or banning its address again. */
export const banPatchSchema = z.union([
  z.object({ permanent: z.literal(true) }).strict(),
  z.object({ again: z.literal(true) }).strict(),
]);
