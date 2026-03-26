import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const externalRoutes = pgTable("external_routes", {
  id: text("id").primaryKey(),
  hostname: text("hostname").notNull().unique(),
  targetUrl: text("target_url").notNull(),
  tls: boolean("tls").notNull().default(false),
  insecureSkipVerify: boolean("insecure_skip_verify").notNull().default(false),
  redirectUrl: text("redirect_url"),
  redirectPermanent: boolean("redirect_permanent").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ExternalRoute = typeof externalRoutes.$inferSelect;
export type NewExternalRoute = typeof externalRoutes.$inferInsert;
