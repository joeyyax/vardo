import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, orgEnvVars } from "@/lib/db/schema";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { MIN_KEYED_LENGTH, redactSecrets, secretEnvValues } from "@/lib/redact";
import { logger } from "@/lib/logger";
import type { BusEvent } from "@/lib/bus";

// Strips secrets from an event before any channel sends it.

const log = logger.child("notifications");

/** Secret values from the org's shared env and, when given, the app's env. */
async function secretValues(orgId: string, appId: string | undefined): Promise<string[]> {
  const env: Record<string, string> = {};
  const publicNames: string[] = [];
  const flagged: string[] = [];

  const orgVars = await db.query.orgEnvVars.findMany({
    where: eq(orgEnvVars.organizationId, orgId),
    columns: { key: true, value: true, isSecret: true },
  });
  for (const v of orgVars) {
    const { content } = decryptOrFallback(v.value, orgId);
    if (!content) continue;
    env[`ORG_${v.key}`] = content;
    if (v.isSecret) flagged.push(content);
  }

  if (appId) {
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { name: true, displayName: true, envContent: true },
    });
    if (app) {
      publicNames.push(app.name, app.displayName);
      const { content } = app.envContent ? decryptOrFallback(app.envContent, orgId) : { content: "" };
      if (content) Object.assign(env, parseEnvToMap(content));
    }
  }

  return [...new Set([...flagged, ...secretEnvValues(env, publicNames)])];
}

/** Every string in `value` redacted, at any depth. */
export function redactPayload<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactSecrets(value, secrets, MIN_KEYED_LENGTH) as T;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, secrets)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactPayload(v, secrets);
    return out as T;
  }
  return value;
}

export async function redactEvent(orgId: string, event: BusEvent): Promise<BusEvent> {
  const appId = "appId" in event && typeof event.appId === "string" ? event.appId : undefined;
  let secrets: string[] = [];
  try {
    secrets = await secretValues(orgId, appId);
  } catch (err) {
    log.warn("Could not load env values for redaction; using patterns only:", err);
  }
  return redactPayload(event, secrets);
}
