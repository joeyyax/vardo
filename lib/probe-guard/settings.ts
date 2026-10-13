// Probe guard settings: per app on the app row, per instance in system_settings.

import { z } from "zod";
import { BLOCK_KINDS, MAX_BLOCK_LENGTH, MAX_NOTE_LENGTH, blockProblem, type CustomBlock } from "./blocks";
import { MAX_EXCEPTIONS, PROBE_RULE_IDS, exceptionProblem, type RuleOverrides } from "./rules";

export type AppProbeGuard = {
  enabled: boolean;
  /** Path prefixes the managed rules leave alone. Custom blocks ignore them. */
  exceptions: string[];
  /** Switches by managed rule id; a rule without one keeps its default. */
  rules: RuleOverrides;
  /** The owner's own turn-away entries. */
  blocks: CustomBlock[];
  /** Templates the owner added, so the UI shows them as added. */
  templates: string[];
  /** Vardo answers /robots.txt with trap lines. Only for apps without their own. */
  robotsTxt: boolean;
};

export const DEFAULT_APP_PROBE_GUARD: AppProbeGuard = { enabled: true, exceptions: [], rules: {}, blocks: [], templates: [], robotsTxt: false };

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

const ruleOverridesSchema = z.record(z.string(), z.boolean()).superRefine((rules, ctx) => {
  for (const id of Object.keys(rules)) {
    if (!PROBE_RULE_IDS.has(id)) ctx.addIssue({ code: "custom", message: `"${id.slice(0, 60)}" isn't a probe rule` });
  }
});

export const customBlockSchema = z
  .object({
    kind: z.enum(BLOCK_KINDS),
    value: z.string().trim().min(1).max(MAX_BLOCK_LENGTH),
    note: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
    template: z.string().max(64).optional(),
  })
  .strict();

const blockListSchema = z
  .array(customBlockSchema)
  .transform((list) => list.filter((b, i) => list.findIndex((o) => o.kind === b.kind && o.value === b.value) === i))
  .superRefine((list, ctx) => {
    for (const b of list) {
      const problem = blockProblem(b);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }
  });

export const appProbeGuardSchema = z
  .object({
    enabled: z.boolean(),
    exceptions: pathListSchema(MAX_EXCEPTIONS),
    rules: ruleOverridesSchema,
    blocks: blockListSchema,
    templates: z.array(z.string().max(64)).transform((list) => [...new Set(list)]),
    robotsTxt: z.boolean(),
  })
  .strict();

/** A stored value read defensively; anything malformed falls back to the default. */
export function normalizeAppProbeGuard(raw: unknown): AppProbeGuard {
  if (raw == null) return DEFAULT_APP_PROBE_GUARD;
  const stored = raw as Partial<AppProbeGuard>;
  const rules = Object.fromEntries(Object.entries(stored.rules ?? {}).filter(([id]) => PROBE_RULE_IDS.has(id)));
  const parsed = appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, ...stored, rules });
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
  /** Entries for every app, added to each app's own. */
  exceptions: string[];
  blocks: CustomBlock[];
};

export const DEFAULT_INSTANCE_PROBE_GUARD: InstanceProbeGuard = {
  threshold: 5,
  windowMinutes: 10,
  banMinutes: 60,
  maxBanHours: 24,
  shareBans: false,
  traps: { enabled: true, paths: DEFAULT_TRAP_PATHS, decoy: true },
  securityContact: "",
  exceptions: [],
  blocks: [],
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
    exceptions: pathListSchema(MAX_EXCEPTIONS),
    blocks: blockListSchema,
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

/** Body for making a ban permanent or banning its address again. */
export const banPatchSchema = z.union([
  z.object({ permanent: z.literal(true) }).strict(),
  z.object({ again: z.literal(true) }).strict(),
]);

/** Field names of `InstanceProbeGuard` that the API treats as known. Any unknown key in the body fails validation. */
const INSTANCE_TOP_KEYS = [
  "threshold",
  "windowMinutes",
  "banMinutes",
  "maxBanHours",
  "shareBans",
  "traps",
  "securityContact",
  "exceptions",
  "blocks",
] as const;

const TRAP_KEYS = ["enabled", "paths", "decoy"] as const;

/** What `InstanceProbeGuard` accepts in a partial POST. Each field is independent; empty body matches all callers. */
export const instanceProbeGuardPartialSchema = z
  .object({
    threshold: z.number().int().min(2).max(100).optional(),
    windowMinutes: z.number().int().min(1).max(1440).optional(),
    banMinutes: z.number().int().min(5).max(1440).optional(),
    maxBanHours: z.number().int().min(1).max(168).optional(),
    shareBans: z.boolean().optional(),
    traps: z
      .object({
        enabled: z.boolean().optional(),
        paths: z.array(z.string().trim()).optional(),
        decoy: z.boolean().optional(),
      })
      .strict()
      .optional(),
    securityContact: z.union([z.literal(""), z.string().trim().email().max(254)]).optional(),
    exceptions: z.array(z.string().trim()).optional(),
    blocks: z.array(customBlockSchema).optional(),
  })
  .strict();

export type InstanceProbeGuardPartial = z.infer<typeof instanceProbeGuardPartialSchema>;

/** One-level-deep merge: top-level fields replace, `traps` merges by key. Unknown keys throw. */
export function mergeInstanceProbeGuard(current: InstanceProbeGuard, patch: InstanceProbeGuardPartial): InstanceProbeGuard {
  for (const key of Object.keys(patch)) {
    if (!INSTANCE_TOP_KEYS.includes(key as (typeof INSTANCE_TOP_KEYS)[number])) {
      throw new Error(`Unknown field "${key}"`);
    }
  }
  const trapsPatch = patch.traps;
  let traps = current.traps;
  if (trapsPatch) {
    for (const key of Object.keys(trapsPatch)) {
      if (!TRAP_KEYS.includes(key as (typeof TRAP_KEYS)[number])) {
        throw new Error(`Unknown traps field "${key}"`);
      }
    }
    traps = { ...traps, ...trapsPatch };
  }
  const merged: InstanceProbeGuard = {
    threshold: patch.threshold ?? current.threshold,
    windowMinutes: patch.windowMinutes ?? current.windowMinutes,
    banMinutes: patch.banMinutes ?? current.banMinutes,
    maxBanHours: patch.maxBanHours ?? current.maxBanHours,
    shareBans: patch.shareBans ?? current.shareBans,
    traps,
    securityContact: patch.securityContact ?? current.securityContact,
    exceptions: patch.exceptions ?? current.exceptions,
    blocks: patch.blocks ?? current.blocks,
  };
  return merged;
}
