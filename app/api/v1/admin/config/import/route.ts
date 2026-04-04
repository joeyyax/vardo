import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { z } from "zod";
import YAML from "yaml";
import JSZip from "jszip";
import { withRateLimit } from "@/lib/api/with-rate-limit";

import {
  importVardoConfig,
  writeVardoConfig,
  type VardoFullConfig,
  type VardoConfig,
  type VardoSecrets,
} from "@/lib/config/vardo-config";

// Zod schema for config validation
const configSchema = z.object({
  instance: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    domain: z.string().optional(),
    baseDomain: z.string().optional(),
    serverIp: z.string().optional(),
  }).optional(),
  auth: z.object({
    registrationMode: z.enum(["closed", "open", "approval"]).optional(),
    sessionDurationDays: z.number().int().positive().optional(),
  }).optional(),
  email: z.object({
    provider: z.enum(["smtp", "mailpace", "resend"]).optional(),
    fromEmail: z.string().optional(),
    fromName: z.string().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.number().optional(),
    smtpUser: z.string().optional(),
  }).optional(),
  backup: z.object({
    type: z.enum(["s3", "r2", "b2", "ssh"]).optional(),
    bucket: z.string().optional(),
    region: z.string().optional(),
    endpoint: z.string().optional(),
  }).optional(),
  github: z.object({
    appId: z.string().optional(),
    appSlug: z.string().optional(),
    clientId: z.string().optional(),
  }).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
}).passthrough();

const secretsSchema = z.object({
  encryptionKey: z.string().optional(),
  authSecret: z.string().optional(),
  acmeEmail: z.string().optional(),
  email: z.object({
    apiKey: z.string().optional(),
    smtpPass: z.string().optional(),
  }).optional(),
  backup: z.object({
    accessKey: z.string().optional(),
    secretKey: z.string().optional(),
  }).optional(),
  github: z.object({
    clientSecret: z.string().optional(),
    privateKey: z.string().optional(),
    webhookSecret: z.string().optional(),
  }).optional(),
}).passthrough();

/**
 * POST /api/v1/admin/config/import?persist=true|false
 *
 * Import configuration from YAML or ZIP.
 *
 * Accepts:
 *   - application/x-yaml: single YAML file (config or full config+secrets)
 *   - application/zip: vardo.zip with vardo.yml + vardo.secrets.yml
 *   - multipart/form-data: file upload
 *
 * Auth: requireAdminAuth OR needsSetup (for onboarding import).
 * ?persist=true writes files to disk alongside DB import.
 */
async function handlePost(request: NextRequest) {
  try {
    // Auth: admin or fresh install (no users exist yet)
    const { needsSetup } = await import("@/lib/setup");
    const isSetup = await needsSetup();

    if (!isSetup) {
      const { requireAdminAuth } = await import("@/lib/auth/admin");
      await requireAdminAuth(request);
    }

    // Only admins can persist to disk — unauthenticated setup path writes to DB only
    const persist = isSetup ? false : request.nextUrl.searchParams.get("persist") === "true";
    const contentType = request.headers.get("content-type") || "";

    let config: VardoConfig = {};
    let secrets: VardoSecrets = {};

    if (contentType.includes("multipart/form-data")) {
      // File upload
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      if (file.name.endsWith(".zip")) {
        const result = await parseZip(buffer);
        config = result.config;
        secrets = result.secrets;
      } else {
        const yaml = buffer.toString("utf-8");
        config = YAML.parse(yaml) || {};
      }
    } else if (contentType.includes("zip")) {
      const buffer = Buffer.from(await request.arrayBuffer());
      const result = await parseZip(buffer);
      config = result.config;
      secrets = result.secrets;
    } else {
      // Raw YAML body
      const text = await request.text();
      config = YAML.parse(text) || {};
    }

    // Validate parsed data
    const configResult = configSchema.safeParse(config);
    if (!configResult.success) {
      return NextResponse.json(
        { error: "Invalid config file", details: configResult.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    config = configResult.data;

    if (Object.keys(secrets).length > 0) {
      const secretsResult = secretsSchema.safeParse(secrets);
      if (!secretsResult.success) {
        return NextResponse.json(
          { error: "Invalid secrets file", details: secretsResult.error.flatten().fieldErrors },
          { status: 400 }
        );
      }
      secrets = secretsResult.data;
    }

    // Merge config + secrets into full config for import
    const full: VardoFullConfig = {
      instance: config.instance,
      auth: config.auth,
      email: { ...config.email, ...secrets.email },
      backup: { ...config.backup, ...secrets.backup },
      github: { ...config.github, ...secrets.github },
      features: config.features,
      secrets: {
        encryptionKey: secrets.encryptionKey,
        authSecret: secrets.authSecret,
        acmeEmail: secrets.acmeEmail,
      },
    };

    // Import to DB
    const imported = await importVardoConfig(full);

    // Optionally persist to disk
    if (persist) {
      await writeVardoConfig(config, secrets);
    }

    // Report which secrets are missing (so the UI can prompt)
    const missingSecrets: string[] = [];
    if (!secrets.encryptionKey) missingSecrets.push("encryptionKey");
    if (!secrets.authSecret) missingSecrets.push("authSecret");
    if (config.email?.provider && !secrets.email?.apiKey && !secrets.email?.smtpPass) {
      missingSecrets.push("email credentials");
    }
    if (config.backup?.type && !secrets.backup?.accessKey) {
      missingSecrets.push("backup credentials");
    }
    if (config.github?.appId && !secrets.github?.clientSecret) {
      missingSecrets.push("github credentials");
    }

    return NextResponse.json({
      ok: true,
      imported,
      missingSecrets,
    });
  } catch (error) {
    return handleRouteError(error, "Error importing config");
  }
}

async function parseZip(buffer: Buffer): Promise<{
  config: VardoConfig;
  secrets: VardoSecrets;
}> {
  const zip = await JSZip.loadAsync(buffer);

  let config: VardoConfig = {};
  let secrets: VardoSecrets = {};

  const configFile = zip.file("vardo.yml");
  if (configFile) {
    const text = await configFile.async("text");
    config = YAML.parse(text) || {};
  }

  const secretsFile = zip.file("vardo.secrets.yml");
  if (secretsFile) {
    const text = await secretsFile.async("text");
    secrets = YAML.parse(text) || {};
  }

  return { config, secrets };
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "config-import" });
