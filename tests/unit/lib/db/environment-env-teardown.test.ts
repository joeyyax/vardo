import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { environmentEnv, environments, groupEnvironments } from "@/lib/db/schema";

// Tearing down a preview deletes its group_environment row. The environment
// rows and their env go with it through these cascades.

function cascadeTarget(table: Parameters<typeof getTableConfig>[0], column: string) {
  const fk = getTableConfig(table).foreignKeys.find((f) =>
    f.reference().columns.some((c) => c.name === column),
  );
  return fk && { onDelete: fk.onDelete, target: getTableConfig(fk.reference().foreignTable).name };
}

describe("environment env teardown", () => {
  it("deletes an environment's env with the environment", () => {
    expect(cascadeTarget(environmentEnv, "environment_id")).toEqual({ onDelete: "cascade", target: "environment" });
  });

  it("deletes a preview's environments with the group environment", () => {
    expect(cascadeTarget(environments, "group_environment_id")).toEqual({
      onDelete: "cascade",
      target: getTableConfig(groupEnvironments).name,
    });
  });
});
