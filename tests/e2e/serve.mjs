// Starts `next dev` against a scratch database for the Playwright smoke run:
// creates the database, applies every migration with the production runner,
// serves on E2E_PORT (default 3100) and drops the database on a clean exit.
//
// Reads .env from the working directory for REDIS_URL (database 15 is flushed), secrets and the Postgres
// admin URL (E2E_ADMIN_URL, else DATABASE_URL). Set BASE_URL to test a server
// that is already running instead. E2E_VERBOSE=1 shows the server output.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import postgres from "postgres";
import Redis from "ioredis";

if (existsSync(".env")) process.loadEnvFile(".env");

const port = process.env.E2E_PORT ?? "3100";
const adminUrl = process.env.E2E_ADMIN_URL ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("[e2e] Set E2E_ADMIN_URL or DATABASE_URL to a Postgres you can create databases on.");
  process.exit(1);
}

// Logical database 15, emptied each run, so rate-limit counters from earlier runs
// (the setup token endpoint allows only a few attempts) don't leak in.
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:7200");
redisUrl.pathname = "/15";
const redis = new Redis(redisUrl.toString());
await redis.flushdb();
await redis.quit();

const quiet = process.env.E2E_VERBOSE ? "inherit" : "ignore";
// Playwright kills this process outright, so a run can leave the database behind.
// A fixed name lets the next run replace it.
const dbName = `vardo_e2e_${port}`;
const withDb = (name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

const admin = postgres(withDb("postgres"), { max: 1, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE "${dbName}"`);

let dropped = false;
async function cleanup() {
  if (dropped) return;
  dropped = true;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 1 }).catch(() => {});
}

const migrated = spawnSync("node", ["scripts/migrate.mjs"], {
  env: { ...process.env, DATABASE_URL: withDb(dbName) },
  stdio: quiet,
});
if (migrated.status !== 0) {
  await cleanup();
  process.exit(1);
}

const url = `http://localhost:${port}`;
const server = spawn("pnpm", ["exec", "next", "dev", "--turbopack", "-p", port], {
  env: {
    ...process.env,
    DATABASE_URL: withDb(dbName),
    REDIS_URL: redisUrl.toString(),
    SETUP_TOKEN: "e2e-setup-token-0123456789",
    NEXT_PUBLIC_APP_URL: url,
    NEXT_PUBLIC_BETTER_AUTH_URL: url,
    BETTER_AUTH_URL: url,
  },
  stdio: quiet,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.kill(signal);
    await cleanup();
    process.exit(0);
  });
}
server.on("exit", async (code) => {
  await cleanup();
  process.exit(code ?? 0);
});
