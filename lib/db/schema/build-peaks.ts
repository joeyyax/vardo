import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { deployments } from "./deployments";

/** Memory a deploy's build used in BuildKit while it ran alone, which sizes how many builds run at once. */
export const buildPeaks = pgTable(
  "build_peak",
  {
    deploymentId: text("deployment_id")
      .primaryKey()
      .references(() => deployments.id, { onDelete: "cascade" }),
    peakBytes: bigint("peak_bytes", { mode: "number" }).notNull(),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (t) => [index("build_peak_recorded_at_idx").on(t.recordedAt)],
);
