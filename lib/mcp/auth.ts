import { createHash } from "crypto";
import { db } from "@/lib/db";
import { apiTokens, user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export type McpAuthContext = {
  userId: string;
  organizationId: string;
};

/**
 * Authenticate an MCP request using a Bearer token.
 *
 * Standalone function that takes a raw Request — no dependency on
 * Next.js AsyncLocalStorage (headers()/cookies()).
 *
 * Returns the resolved user + org context, or null if invalid.
 */
export async function authenticateRequest(
  request: Request
): Promise<McpAuthContext | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) return null;

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const token = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, tokenHash),
    columns: { id: true, userId: true, organizationId: true },
  });

  if (!token) return null;

  // Verify the user still exists
  const tokenUser = await db.query.user.findFirst({
    where: eq(user.id, token.userId),
    columns: { id: true },
  });

  if (!tokenUser) return null;

  // Update lastUsedAt in the background — fire and forget
  db.update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, token.id))
    .catch(() => {});

  return {
    userId: token.userId,
    organizationId: token.organizationId,
  };
}
