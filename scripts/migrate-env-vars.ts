/**
 * Migration script: move env_vars rows to encrypted envContent blobs on apps.
 *
 * Run with: npx tsx scripts/migrate-env-vars.ts
 *
 * Requires ENCRYPTION_MASTER_KEY environment variable to be set.
 */

import { db } from "@/lib/db";
import { apps, envVars } from "@/lib/db/schema";
import { eq, isNull } from "drizzle-orm";
import { encrypt } from "@/lib/crypto/encrypt";

async function migrate() {
  if (!process.env.ENCRYPTION_MASTER_KEY) {
    console.error("ENCRYPTION_MASTER_KEY environment variable is required");
    process.exit(1);
  }

  const allApps = await db.query.apps.findMany({
    columns: { id: true, name: true, organizationId: true, envContent: true },
  });

  console.log(`Found ${allApps.length} apps`);
  let migrated = 0;
  let skipped = 0;

  for (const app of allApps) {
    // Skip if already has encrypted content
    if (app.envContent) {
      console.log(`  [skip] ${app.name} — already has envContent`);
      skipped++;
      continue;
    }

    // Load base env vars (no environment scoping)
    const vars = await db.query.envVars.findMany({
      where: eq(envVars.appId, app.id),
    });

    if (vars.length === 0) {
      console.log(`  [skip] ${app.name} — no env vars`);
      skipped++;
      continue;
    }

    // Build .env content from rows
    const content = vars
      .map((v) => `${v.key}=${v.value}`)
      .join("\n");

    // Encrypt and save
    const encrypted = encrypt(content, app.organizationId);
    await db
      .update(apps)
      .set({ envContent: encrypted })
      .where(eq(apps.id, app.id));

    console.log(`  [migrated] ${app.name} — ${vars.length} vars`);
    migrated++;
  }

  console.log(`\nDone: ${migrated} migrated, ${skipped} skipped`);
}

migrate().catch(console.error);
