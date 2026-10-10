import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { UI_DENSITIES } from "./enums";

// Interface settings that follow a user across devices.
export const userPreferences = pgTable("user_preference", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  density: text("density", { enum: UI_DENSITIES }).notNull().default("comfortable"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
