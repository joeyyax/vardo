/**
 * Migration script: promote persistentVolumes JSONB and volume_limits rows
 * into the new first-class `volumes` table.
 *
 * Run with: npx tsx scripts/migrate-volumes.ts
 *
 * Safe to run multiple times (idempotent via onConflictDoNothing).
 */

import { db } from "@/lib/db";
import { volumes, volumeLimits } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

async function migrate() {
  const allApps = await db.query.apps.findMany({
    columns: {
      id: true,
      name: true,
      organizationId: true,
      persistentVolumes: true,
    },
  });

  console.log(`Found ${allApps.length} apps`);

  let volumesMigrated = 0;
  let limitsMerged = 0;
  let skipped = 0;

  for (const app of allApps) {
    const jsonbVolumes = (app.persistentVolumes as { name: string; mountPath: string }[] | null) ?? [];

    if (jsonbVolumes.length === 0) {
      console.log(`  [skip] ${app.name} -- no persistentVolumes JSONB`);
      skipped++;
      continue;
    }

    // Load any existing volume_limits for this app
    const limit = await db.query.volumeLimits.findFirst({
      where: eq(volumeLimits.appId, app.id),
    });

    for (const vol of jsonbVolumes) {
      try {
        await db.insert(volumes).values({
          id: nanoid(),
          appId: app.id,
          organizationId: app.organizationId,
          name: vol.name,
          mountPath: vol.mountPath,
          persistent: true,
          shared: false,
          maxSizeBytes: limit?.maxSizeBytes ?? null,
          warnAtPercent: limit?.warnAtPercent ?? 80,
        }).onConflictDoNothing();

        volumesMigrated++;
      } catch (err) {
        console.error(`  [error] ${app.name}/${vol.name}: ${err}`);
      }
    }

    if (limit) {
      limitsMerged++;
      console.log(`  [migrated] ${app.name} -- ${jsonbVolumes.length} volume(s), limit merged (${limit.maxSizeBytes} bytes, ${limit.warnAtPercent}%)`);
    } else {
      console.log(`  [migrated] ${app.name} -- ${jsonbVolumes.length} volume(s)`);
    }
  }

  console.log(`\nDone:`);
  console.log(`  ${volumesMigrated} volume records created`);
  console.log(`  ${limitsMerged} volume_limits merged into volume records`);
  console.log(`  ${skipped} apps skipped (no JSONB data)`);
  console.log(`\nNext steps:`);
  console.log(`  1. Verify data: SELECT * FROM volume;`);
  console.log(`  2. Once confirmed, the persistentVolumes JSONB column and volume_limit table can be dropped.`);
}

migrate().catch(console.error);
