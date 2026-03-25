import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Load .env from repo root
config({ path: "./.env", quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
