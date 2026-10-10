import type { organizations } from "@/lib/db/schema";
import { can, type Capability } from "@/lib/auth/permissions";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { FeatureDisabledError, ForbiddenError } from "./errors";

export type Organization = typeof organizations.$inferSelect;

/** Who is asking, in which org, with what. Every service takes one. Build it with session-actor or mcp-actor. */
export type Actor = {
  userId: string;
  org: Organization;
  /** The role, narrowed by a token's scope when the caller is a token. */
  membership: { id?: string; role: string; scopes?: ReadonlySet<Capability> | null };
  /** Instance admin with a credential allowed to use it. */
  instanceAdmin: boolean;
};

/** Whether the actor holds `cap` in their org. */
export function allows(actor: Actor, cap: Capability): boolean {
  return can(actor.membership, cap, { instanceAdmin: actor.instanceAdmin });
}

/** Throws ForbiddenError unless the actor holds `cap`. */
export function authorize(actor: Actor, cap: Capability): void {
  if (!allows(actor, cap)) throw new ForbiddenError(cap);
}

/** Throws FeatureDisabledError when `flag` is off. */
export async function requireFeature(flag: FeatureFlag): Promise<void> {
  if (!(await isFeatureEnabledAsync(flag))) throw new FeatureDisabledError(flag);
}
