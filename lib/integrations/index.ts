import { db } from "@/lib/db";
import { apps, integrations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { decryptSystemOrFallback, encryptSystem } from "@/lib/crypto/encrypt";
import { logger } from "@/lib/logger";

const log = logger.child("integrations");

export type IntegrationType = "metrics" | "error_tracking" | "uptime" | "logging";
export type IntegrationStatus = "connected" | "disconnected" | "degraded";

export type Integration = {
  id: string;
  type: IntegrationType;
  status: IntegrationStatus;
  appId: string | null;
  externalUrl: string | null;
  config: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Get the integration for a given type.
 * Returns null if no integration of that type is configured.
 */
export async function getIntegration(type: IntegrationType): Promise<Integration | null> {
  const row = await db.query.integrations.findFirst({
    where: eq(integrations.type, type),
  });
  if (!row) return null;
  return row as Integration;
}

/**
 * Get all configured integrations (strips encrypted credentials).
 */
export async function getAllIntegrations(): Promise<Integration[]> {
  const rows = await db.query.integrations.findMany();
  return (rows as Integration[]).map(stripCredentials);
}

/** Remove encrypted credentials from integration for API responses. */
function stripCredentials(integration: Integration): Integration {
  const { ...rest } = integration;
  return { ...rest, credentials: undefined } as unknown as Integration;
}

/**
 * Connect an integration backed by a Vardo-deployed app.
 * Atomic upsert — safe against concurrent requests.
 */
export async function connectAppIntegration(
  type: IntegrationType,
  appId: string,
  config?: Record<string, unknown>,
): Promise<Integration> {
  const now = new Date();

  const [result] = await db
    .insert(integrations)
    .values({
      id: nanoid(),
      type,
      status: "connected",
      appId,
      externalUrl: null,
      credentials: null,
      config: config ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: integrations.type,
      set: {
        status: "connected",
        appId,
        externalUrl: null,
        credentials: null,
        config: config ?? null,
        updatedAt: now,
      },
    })
    .returning();

  log.info(`Connected ${type} integration → app ${appId}`);
  return result as Integration;
}

/**
 * Connect an integration backed by an external instance.
 * Atomic upsert — safe against concurrent requests.
 */
export async function connectExternalIntegration(
  type: IntegrationType,
  externalUrl: string,
  apiToken?: string,
  config?: Record<string, unknown>,
): Promise<Integration> {
  const now = new Date();
  const encryptedCreds = apiToken ? encryptSystem(apiToken) : null;

  const [result] = await db
    .insert(integrations)
    .values({
      id: nanoid(),
      type,
      status: "connected",
      appId: null,
      externalUrl,
      credentials: encryptedCreds,
      config: config ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: integrations.type,
      set: {
        status: "connected",
        appId: null,
        externalUrl,
        credentials: encryptedCreds,
        config: config ?? null,
        updatedAt: now,
      },
    })
    .returning();

  log.info(`Connected ${type} integration → ${externalUrl}`);
  return result as Integration;
}

/**
 * Disconnect an integration. Clears sensitive fields.
 */
export async function disconnectIntegration(type: IntegrationType): Promise<void> {
  await db
    .update(integrations)
    .set({
      status: "disconnected",
      appId: null,
      externalUrl: null,
      credentials: null,
      updatedAt: new Date(),
    })
    .where(eq(integrations.type, type));
  log.info(`Disconnected ${type} integration`);
}

/**
 * Update integration status (e.g. connected → degraded when health check fails).
 */
export async function updateIntegrationStatus(
  type: IntegrationType,
  status: IntegrationStatus,
): Promise<void> {
  await db
    .update(integrations)
    .set({ status, updatedAt: new Date() })
    .where(eq(integrations.type, type));
}

/**
 * Resolve the URL for an integration.
 * App-backed: derives from Docker network DNS.
 * External: returns the configured URL.
 */
export async function resolveIntegrationUrl(type: IntegrationType): Promise<string | null> {
  const integration = await getIntegration(type);
  if (!integration || integration.status === "disconnected") return null;

  // External instance — use the URL directly
  if (integration.externalUrl) return integration.externalUrl;

  // App-backed — resolve via Docker network DNS (same node as Vardo console).
  // Remote instances should use the external URL path instead.
  if (integration.appId) {
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, integration.appId),
      columns: { name: true },
    });
    if (!app) return null;

    // Default port convention per integration type
    const defaultPorts: Record<IntegrationType, number> = {
      metrics: 8080,       // cAdvisor
      error_tracking: 8000, // GlitchTip
      uptime: 3001,        // Uptime Kuma
      logging: 3000,       // Grafana
    };
    const port = (integration.config?.port as number) ?? defaultPorts[type];
    return `http://${app.name}:${port}`;
  }

  return null;
}

/**
 * Get decrypted credentials for an integration.
 */
export async function getIntegrationCredentials(type: IntegrationType): Promise<string | null> {
  const row = await db.query.integrations.findFirst({
    where: eq(integrations.type, type),
    columns: { credentials: true },
  });
  if (!row?.credentials) return null;
  return decryptSystemOrFallback(row.credentials).content || null;
}
