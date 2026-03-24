import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import YAML from "yaml";
import JSZip from "jszip";
import {
  importVardoConfig,
  writeVardoConfig,
  type VardoFullConfig,
  type VardoConfig,
  type VardoSecrets,
} from "@/lib/config/vardo-config";

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
export async function POST(request: NextRequest) {
  try {
    // Auth: admin or fresh install
    const { needsSetup } = await import("@/lib/setup");
    const isSetup = await needsSetup();

    if (!isSetup) {
      const { requireAdminAuth } = await import("@/lib/auth/admin");
      await requireAdminAuth(request);
    }

    const persist = request.nextUrl.searchParams.get("persist") === "true";
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
