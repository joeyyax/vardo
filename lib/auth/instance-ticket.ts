// Redeems a linked instance's sign-in ticket into a normal session for the local user it names.

import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { activityOrgFor, redeemTicket, TicketError, type Redeemed } from "@/lib/instances/ticket";

/** Matches CURRENT_ORG_COOKIE in lib/auth/session.ts. */
const CURRENT_ORG_COOKIE = "host_current_org";

export function instanceTicket(): BetterAuthPlugin {
  return {
    id: "vardo-instance-ticket",
    endpoints: {
      redeemInstanceTicket: createAuthEndpoint(
        "/instance-ticket",
        { method: "GET", query: z.object({ ticket: z.string().max(128) }) },
        async (ctx) => {
          const base = ctx.context.baseURL;
          const fail = (message: string): never => {
            const url = new URL("/login", base);
            url.searchParams.set("error", "instance_ticket");
            url.searchParams.set("error_description", message);
            throw ctx.redirect(url.toString());
          };

          let redeemed: Redeemed;
          try {
            redeemed = await redeemTicket(ctx.query.ticket);
          } catch (err) {
            if (err instanceof TicketError) return fail(err.message);
            throw err;
          }

          const found = await ctx.context.internalAdapter.findUserById(redeemed.userId);
          if (!found) return fail("That account no longer exists here.");
          const session = await ctx.context.internalAdapter.createSession(found.id);
          if (!session) return fail("Couldn't start a session. Try again.");
          await setSessionCookie(ctx, { session, user: found });

          if (redeemed.organizationId) {
            ctx.setCookie(CURRENT_ORG_COOKIE, redeemed.organizationId, {
              path: "/",
              maxAge: 60 * 60 * 24 * 365,
              httpOnly: true,
              sameSite: "lax",
              secure: process.env.NODE_ENV === "production",
            });
          }

          const orgId = await activityOrgFor(found.id, redeemed.organizationId).catch(() => null);
          if (orgId) {
            await recordActivity({
              organizationId: orgId,
              action: "mesh.instance_signin_received",
              userId: found.id,
              metadata: { trigger: redeemed.peer.name, peerId: redeemed.peer.id, originInstanceId: redeemed.peer.instanceId },
            }).catch(() => {});
          }

          throw ctx.redirect(new URL(redeemed.next, base).toString());
        },
      ),
    },
  };
}
