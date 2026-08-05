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

// The object is already in its target state. Only reachable on a database left
// half-applied by the older non-transactional runner, or altered out of band.
const IGNORABLE = new Set([
  "42710", // duplicate_object (enum value, constraint)
  "42701", // duplicate_column
  "42P07", // duplicate_table
  "42P16", // invalid_table_definition (constraint already exists)
]);

// Postgres refuses the statement inside a transaction block.
const NON_TRANSACTIONAL = new Set([
  "25001", // active_sql_transaction (CREATE INDEX CONCURRENTLY, VACUUM, ...)
  "55P04", // unsafe_new_enum_value_usage (enum value used in the transaction that added it)
]);

// A tolerated error still poisons the transaction, so each statement gets a savepoint.
async function runStatement(db, stmt, transactional) {
  try {
    if (transactional) await db.savepoint((sp) => sp.unsafe(stmt));
    else await db.unsafe(stmt);
  } catch (err) {
    if (!IGNORABLE.has(err.code)) throw err;
    console.log(
      `[migrate]   ↳ Skipped (already exists): ${err.message.split("\n")[0]}`,
    );
  }
}

const recordSql = (db, tag) =>
  db`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${tag}, ${Date.now()})`;

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

    try {
      // Statements and the journal row commit together — applied and recorded, or neither.
      await sql.begin(async (tx) => {
        for (const stmt of statements) await runStatement(tx, stmt, true);
        await recordSql(tx, entry.tag);
      });
    } catch (err) {
      if (!NON_TRANSACTIONAL.has(err.code)) throw err;

      // The transaction rolled back, so nothing was applied and replaying is safe.
      // Unwrapped is the only way these statements can run — atomicity is lost.
      console.warn(
        `[migrate]   ↳ ${entry.tag} cannot run inside a transaction (${err.code}) — applying it unwrapped, partial failure is possible`,
      );
      for (const stmt of statements) await runStatement(sql, stmt, false);
      await recordSql(sql, entry.tag);
    }

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
