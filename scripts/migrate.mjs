// Minimal migration runner for production containers.
// Reads drizzle migration journal and applies pending SQL files.
// No drizzle-kit or esbuild dependency required.

import { readFileSync } from "fs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[migrate] DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

try {
  // Ensure migration tracking table exists
  await sql`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `;

  // Read journal
  const journal = JSON.parse(
    readFileSync("./drizzle/meta/_journal.json", "utf-8"),
  );

  // Get already-applied migrations
  const applied = await sql`SELECT hash FROM __drizzle_migrations`;
  const appliedHashes = new Set(applied.map((r) => r.hash));

  let count = 0;
  for (const entry of journal.entries) {
    if (appliedHashes.has(entry.tag)) continue;

    const filePath = `./drizzle/${entry.tag}.sql`;
    const raw = readFileSync(filePath, "utf-8");

    // Drizzle uses "--> statement-breakpoint" to delimit statements
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    console.log(
      `[migrate] Applying ${entry.tag} (${statements.length} statements)...`,
    );

    for (const stmt of statements) {
      try {
        await sql.unsafe(stmt);
      } catch (err) {
        // Tolerate DDL conflicts from partially-applied or out-of-band schema changes.
        // These are safe to skip — the object already exists in the target state.
        const code = err.code;
        const ignorable =
          code === "42710" || // duplicate_object (enum value, constraint)
          code === "42701" || // duplicate_column
          code === "42P07" || // duplicate_table
          code === "42P16";   // invalid_table_definition (constraint already exists)

        if (ignorable) {
          console.log(`[migrate]   ↳ Skipped (already exists): ${err.message.split("\n")[0]}`);
        } else {
          throw err;
        }
      }
    }

    await sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${entry.tag}, ${Date.now()})`;
    count++;
  }

  if (count === 0) {
    console.log("[migrate] Database is up to date");
  } else {
    console.log(`[migrate] Applied ${count} migration(s)`);
  }
} catch (err) {
  console.error("[migrate] Failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
