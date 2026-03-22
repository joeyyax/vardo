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
      await sql.unsafe(stmt);
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
