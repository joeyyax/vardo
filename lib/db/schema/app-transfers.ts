import {
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { transferStatusEnum } from "./enums";
import { apps } from "./apps";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// App Transfers (move apps between organizations)
// ---------------------------------------------------------------------------

export const appTransfers = pgTable("app_transfer", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  sourceOrgId: text("source_org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  destinationOrgId: text("destination_org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  status: transferStatusEnum("status").notNull().default("pending"),
  initiatedBy: text("initiated_by")
    .references(() => user.id, { onDelete: "set null" }),
  respondedBy: text("responded_by")
    .references(() => user.id, { onDelete: "set null" }),
  frozenRefs: jsonb("frozen_refs").$type<
    { key: string; originalRef: string; frozenValue: string }[]
  >(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  respondedAt: timestamp("responded_at"),
});
