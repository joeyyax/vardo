import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Load .env from workspace root (env lives at root for docker-compose)
config({ path: "../../.env", quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
