import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// Cached on globalThis so a hot reload reuses the pool. Without this every HMR
// pass opens a new one and dev hits "too many clients" within minutes.
const globalForDb = globalThis as unknown as {
  vardoPgClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.vardoPgClient ??
  postgres(connectionString, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForDb.vardoPgClient = client;

export const db = drizzle(client, { schema });
