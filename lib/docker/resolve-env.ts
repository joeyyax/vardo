import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export type ResolvedEnv = {
  name: string;
  type: "production" | "staging" | "preview" | "local";
  id: string | null;
};

export async function resolveDefaultEnv(appId: string): Promise<ResolvedEnv> {
  const env = await db.query.environments.findFirst({
    where: and(eq(environments.appId, appId), eq(environments.isDefault, true)),
    columns: { id: true, name: true, type: true },
  });

  return {
    name: env?.name ?? "production",
    type: env?.type ?? "production",
    id: env?.id ?? null,
  };
}
