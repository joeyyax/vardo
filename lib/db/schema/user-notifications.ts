import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// User Notifications (persistent toast inbox)
//
// Stores persistent toasts that require user action (dismiss, click-through).
// Temp and progress toasts are stream-only — they don't hit this table.
// ---------------------------------------------------------------------------

export const userNotifications = pgTable(
  "user_notification",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    actionUrl: text("action_url"),
    readAt: timestamp("read_at"),
    dismissedAt: timestamp("dismissed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("user_notification_user_unread_idx").on(t.userId, t.dismissedAt),
  ],
);
