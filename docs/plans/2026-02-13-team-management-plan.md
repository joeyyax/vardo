# Team Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add team management to orgs — invite members, manage roles, control project-level visibility, and enforce role-based access across all API routes.

**Architecture:** New `team_invitations` and `project_members` tables. New `/team` page (full route) accessed from org switcher dropdown. Permission helper in `lib/auth/permissions.ts` centralizes role checks and project-scoped filtering. All existing API routes get visibility filtering for `member` role.

**Tech Stack:** Next.js App Router, Drizzle ORM, MailPace email, shadcn/ui, nanoid for tokens.

**Design doc:** `docs/plans/2026-02-13-team-management-design.md`

---

## Task 1: Schema — Add `team_invitations` and `project_members` tables

**Files:**
- Modify: `lib/db/schema.ts`

**Step 1: Add `team_invitations` table after the `memberships` table (around line 194)**

```typescript
// Team invitations (for inviting users to join an organization)
export const teamInvitations = pgTable("team_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"), // admin, member
  invitedBy: text("invited_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, accepted, expired
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});
```

**Step 2: Add `project_members` table after `team_invitations`**

```typescript
// Project members (controls which projects a member can access)
// Admins and owners bypass this — they have implicit access to all projects
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_members_project_user_idx").on(
      table.projectId,
      table.userId
    ),
  ]
);
```

**Step 3: Add `joinToken` and `joinEnabled` columns to the `organizations` table**

Add these two columns to the existing `organizations` table definition, before `createdAt`:

```typescript
  // Team join link
  joinToken: text("join_token").unique(),
  joinEnabled: boolean("join_enabled").default(false),
```

**Step 4: Add relations for new tables**

Add near the existing relations section (after `membershipsRelations` around line 1695):

```typescript
export const teamInvitationsRelations = relations(
  teamInvitations,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [teamInvitations.organizationId],
      references: [organizations.id],
    }),
    inviter: one(users, {
      fields: [teamInvitations.invitedBy],
      references: [users.id],
    }),
  })
);

export const projectMembersRelations = relations(
  projectMembers,
  ({ one }) => ({
    project: one(projects, {
      fields: [projectMembers.projectId],
      references: [projects.id],
    }),
    user: one(users, {
      fields: [projectMembers.userId],
      references: [users.id],
    }),
  })
);
```

**Step 5: Add `projectMembers` to `projectsRelations`**

In the existing `projectsRelations` (around line 1734), add:

```typescript
  members: many(projectMembers),
```

**Step 6: Add `teamInvitations` to `organizationsRelations`**

In the existing `organizationsRelations` (around line 1618), add:

```typescript
  teamInvitations: many(teamInvitations),
```

**Step 7: Push schema**

Run: `pnpm db:push`
Expected: Schema changes applied, new tables created.

**Step 8: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat: add team_invitations and project_members tables"
```

---

## Task 2: Permission helper — `lib/auth/permissions.ts`

**Files:**
- Create: `lib/auth/permissions.ts`

This centralizes role checks and project-scoped filtering so API routes can use a single helper.

**Step 1: Create the permissions helper**

```typescript
import { db } from "@/lib/db";
import { projectMembers } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

type MembershipRole = "owner" | "admin" | "member";

/**
 * Check if a role has admin-level access (owner or admin).
 */
export function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Require admin role, throw if not.
 */
export function requireAdmin(role: string): void {
  if (!isAdminRole(role)) {
    throw new Error("Forbidden");
  }
}

/**
 * Get the project IDs a member has been assigned to.
 * Returns null for admin/owner (meaning "all projects").
 */
export async function getAccessibleProjectIds(
  userId: string,
  role: string
): Promise<string[] | null> {
  if (isAdminRole(role)) return null; // no filtering needed

  const assignments = await db.query.projectMembers.findMany({
    where: eq(projectMembers.userId, userId),
    columns: { projectId: true },
  });

  return assignments.map((a) => a.projectId);
}
```

**Step 2: Commit**

```bash
git add lib/auth/permissions.ts
git commit -m "feat: add role-based permission helpers"
```

---

## Task 3: Team invitations API — create, list, revoke, resend

**Files:**
- Create: `app/api/v1/organizations/[orgId]/team-invitations/route.ts`
- Create: `app/api/v1/organizations/[orgId]/team-invitations/[invitationId]/route.ts`

**Step 1: Create the main invitations route (GET + POST)**

`app/api/v1/organizations/[orgId]/team-invitations/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { teamInvitations, memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { teamInvitationEmail } from "@/lib/email/team-invitation-email";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/team-invitations
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const invitations = await db.query.teamInvitations.findMany({
      where: and(
        eq(teamInvitations.organizationId, orgId),
        eq(teamInvitations.status, "pending")
      ),
      with: {
        inviter: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    return NextResponse.json({ invitations });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching team invitations:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/team-invitations
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { email, role = "member" } = body;

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    if (!["admin", "member"].includes(role)) {
      return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
    }

    // Check if user is already a member
    const existingMembers = await db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      with: { user: { columns: { email: true } } },
    });

    if (existingMembers.some((m) => m.user.email === email)) {
      return NextResponse.json(
        { error: "This person is already a member of this organization" },
        { status: 409 }
      );
    }

    // Check for existing pending invitation
    const existingInvitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.organizationId, orgId),
        eq(teamInvitations.email, email),
        eq(teamInvitations.status, "pending")
      ),
    });

    if (existingInvitation) {
      return NextResponse.json(
        { error: "An invitation has already been sent to this email" },
        { status: 409 }
      );
    }

    // Create invitation
    const token = nanoid(32);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const [invitation] = await db
      .insert(teamInvitations)
      .values({
        organizationId: orgId,
        email,
        role,
        invitedBy: session.user.id,
        token,
        status: "pending",
        expiresAt,
      })
      .returning();

    // Send invitation email
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const inviteUrl = `${baseUrl}/invitations/team/${token}`;

    await sendEmail(
      teamInvitationEmail({
        organizationName: organization.name,
        invitedByName: session.user.name || session.user.email,
        inviteUrl,
        role,
      }),
      {
        organizationId: orgId,
        entityType: "invitation",
        entityId: invitation.id,
      }
    );

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating team invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Create the individual invitation route (DELETE for revoke, POST for resend)**

`app/api/v1/organizations/[orgId]/team-invitations/[invitationId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teamInvitations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { teamInvitationEmail } from "@/lib/email/team-invitation-email";

type RouteParams = {
  params: Promise<{ orgId: string; invitationId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/team-invitations/[invitationId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const [deleted] = await db
      .delete(teamInvitations)
      .where(
        and(
          eq(teamInvitations.id, invitationId),
          eq(teamInvitations.organizationId, orgId)
        )
      )
      .returning();

    if (!deleted) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error revoking invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/team-invitations/[invitationId]/resend
// Using POST on the invitation itself to resend the email
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const invitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.id, invitationId),
        eq(teamInvitations.organizationId, orgId),
        eq(teamInvitations.status, "pending")
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const inviteUrl = `${baseUrl}/invitations/team/${invitation.token}`;

    await sendEmail(
      teamInvitationEmail({
        organizationName: organization.name,
        invitedByName: session.user.name || session.user.email,
        inviteUrl,
        role: invitation.role,
      }),
      {
        organizationId: orgId,
        entityType: "invitation",
        entityId: invitation.id,
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error resending invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/team-invitations/
git commit -m "feat: add team invitation API (create, list, revoke, resend)"
```

---

## Task 4: Member management API — update role, remove

**Files:**
- Create: `app/api/v1/organizations/[orgId]/members/[userId]/route.ts`

**Step 1: Create the member management route (PATCH + DELETE)**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; userId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/members/[userId]
// Update a member's role
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { role } = body;

    if (!["admin", "member"].includes(role)) {
      return NextResponse.json(
        { error: "Role must be 'admin' or 'member'" },
        { status: 400 }
      );
    }

    // Find the target membership
    const targetMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId)
      ),
    });

    if (!targetMembership) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Can't change the owner's role
    if (targetMembership.role === "owner") {
      return NextResponse.json(
        { error: "Cannot change the owner's role" },
        { status: 403 }
      );
    }

    // Update role
    const [updated] = await db
      .update(memberships)
      .set({ role })
      .where(eq(memberships.id, targetMembership.id))
      .returning();

    return NextResponse.json({
      member: { id: updated.userId, role: updated.role },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error updating member:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/members/[userId]
// Remove a member from the organization
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    // Find the target membership
    const targetMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId)
      ),
    });

    if (!targetMembership) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Can't remove the owner
    if (targetMembership.role === "owner") {
      return NextResponse.json(
        { error: "Cannot remove the organization owner" },
        { status: 403 }
      );
    }

    // Can't remove yourself (use leave org instead)
    if (userId === session.user.id) {
      return NextResponse.json(
        { error: "Cannot remove yourself" },
        { status: 400 }
      );
    }

    // Delete membership
    await db
      .delete(memberships)
      .where(eq(memberships.id, targetMembership.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error removing member:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/members/\[userId\]/
git commit -m "feat: add member management API (update role, remove)"
```

---

## Task 5: Join link API and invitation acceptance

**Files:**
- Create: `app/api/v1/organizations/[orgId]/join-link/route.ts`
- Create: `app/(public)/invitations/team/[token]/page.tsx`
- Create: `app/api/v1/team-invitations/accept/route.ts`

**Step 1: Create join link management route**

`app/api/v1/organizations/[orgId]/join-link/route.ts` — GET (current state), PATCH (toggle/regenerate):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/join-link
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    return NextResponse.json({
      joinToken: organization.joinToken,
      joinEnabled: organization.joinEnabled,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error fetching join link:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/join-link
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { enabled, regenerate } = body;

    const updates: Record<string, unknown> = {};

    if (typeof enabled === "boolean") {
      updates.joinEnabled = enabled;
      // Auto-generate a token if enabling for the first time
      if (enabled && !organization.joinToken) {
        updates.joinToken = nanoid(32);
      }
    }

    if (regenerate) {
      updates.joinToken = nanoid(32);
    }

    const [updated] = await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, orgId))
      .returning({
        joinToken: organizations.joinToken,
        joinEnabled: organizations.joinEnabled,
      });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error updating join link:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Create team invitation acceptance API route**

`app/api/v1/team-invitations/accept/route.ts` — handles both email invitation tokens and join link tokens:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  teamInvitations,
  memberships,
  organizations,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

// POST /api/v1/team-invitations/accept
// Body: { token: string, type: "invitation" | "join" }
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const { token, type } = body;

    if (!token) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    if (type === "join") {
      // Handle join link
      const org = await db.query.organizations.findFirst({
        where: and(
          eq(organizations.joinToken, token),
          eq(organizations.joinEnabled, true)
        ),
      });

      if (!org) {
        return NextResponse.json(
          { error: "Invalid or disabled join link" },
          { status: 404 }
        );
      }

      // Check if already a member
      const existing = await db.query.memberships.findFirst({
        where: and(
          eq(memberships.organizationId, org.id),
          eq(memberships.userId, session.user.id)
        ),
      });

      if (existing) {
        return NextResponse.json(
          { error: "You are already a member of this organization" },
          { status: 409 }
        );
      }

      // Create membership as member
      await db.insert(memberships).values({
        organizationId: org.id,
        userId: session.user.id,
        role: "member",
      });

      return NextResponse.json({
        success: true,
        organizationId: org.id,
        organizationName: org.name,
      });
    }

    // Handle email invitation token
    const invitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.token, token),
        eq(teamInvitations.status, "pending")
      ),
      with: {
        organization: { columns: { id: true, name: true } },
      },
    });

    if (!invitation) {
      return NextResponse.json(
        { error: "Invalid or expired invitation" },
        { status: 404 }
      );
    }

    // Check expiration
    if (new Date() > invitation.expiresAt) {
      await db
        .update(teamInvitations)
        .set({ status: "expired" })
        .where(eq(teamInvitations.id, invitation.id));

      return NextResponse.json(
        { error: "This invitation has expired" },
        { status: 410 }
      );
    }

    // Check if already a member
    const existing = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, invitation.organizationId),
        eq(memberships.userId, session.user.id)
      ),
    });

    if (existing) {
      // Mark invitation as accepted anyway
      await db
        .update(teamInvitations)
        .set({ status: "accepted" })
        .where(eq(teamInvitations.id, invitation.id));

      return NextResponse.json(
        { error: "You are already a member of this organization" },
        { status: 409 }
      );
    }

    // Create membership with the invited role
    await db.insert(memberships).values({
      organizationId: invitation.organizationId,
      userId: session.user.id,
      role: invitation.role,
    });

    // Mark invitation as accepted
    await db
      .update(teamInvitations)
      .set({ status: "accepted" })
      .where(eq(teamInvitations.id, invitation.id));

    return NextResponse.json({
      success: true,
      organizationId: invitation.organization.id,
      organizationName: invitation.organization.name,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error accepting invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 3: Create the invitation acceptance page**

`app/(public)/invitations/team/[token]/page.tsx` — public page that shows org name and prompts login/signup if needed, then calls the accept API:

This is a client-rendered page. If the user is logged in, it calls the accept API immediately. If not, it redirects to login with a `callbackUrl` that returns them here after auth.

```typescript
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { teamInvitations, organizations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { TeamInvitationAccept } from "./accept-client";

type PageProps = {
  params: Promise<{ token: string }>;
};

export default async function TeamInvitationPage({ params }: PageProps) {
  const { token } = await params;

  // Determine if this is a join link or email invitation
  // Try email invitation first
  const invitation = await db.query.teamInvitations.findFirst({
    where: and(
      eq(teamInvitations.token, token),
      eq(teamInvitations.status, "pending")
    ),
    with: {
      organization: { columns: { id: true, name: true } },
    },
  });

  // Try join link
  const joinOrg = !invitation
    ? await db.query.organizations.findFirst({
        where: and(
          eq(organizations.joinToken, token),
          eq(organizations.joinEnabled, true)
        ),
        columns: { id: true, name: true },
      })
    : null;

  if (!invitation && !joinOrg) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold">Invalid Invitation</h1>
          <p className="text-muted-foreground">
            This invitation link is invalid or has expired.
          </p>
        </div>
      </div>
    );
  }

  const session = await getSession();
  const orgName = invitation?.organization.name || joinOrg?.name || "";
  const type = invitation ? "invitation" : "join";

  if (!session?.user) {
    // Redirect to login with callback
    const callbackUrl = `/invitations/team/${token}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  return (
    <TeamInvitationAccept
      token={token}
      type={type}
      organizationName={orgName}
    />
  );
}
```

**Step 4: Create the client component for accepting**

`app/(public)/invitations/team/[token]/accept-client.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Building2 } from "lucide-react";

type Props = {
  token: string;
  type: "invitation" | "join";
  organizationName: string;
};

export function TeamInvitationAccept({ token, type, organizationName }: Props) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setAccepting(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/team-invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, type }),
      });

      if (res.ok) {
        const data = await res.json();
        // Switch to the org and redirect
        document.cookie = `time_current_org=${data.organizationId};path=/;max-age=${60 * 60 * 24 * 365}`;
        router.push("/track");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to accept invitation");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md squircle">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Building2 className="size-6" />
          </div>
          <CardTitle>Join {organizationName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            You&apos;ve been invited to join {organizationName}. Click below to
            accept and get started.
          </p>
          {error && (
            <p className="text-center text-sm text-destructive">{error}</p>
          )}
          <Button
            onClick={handleAccept}
            disabled={accepting}
            className="w-full squircle"
          >
            {accepting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Joining...
              </>
            ) : (
              "Join Organization"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/join-link/ app/api/v1/team-invitations/ app/\(public\)/invitations/team/
git commit -m "feat: add join link API and invitation acceptance flow"
```

---

## Task 6: Team invitation email template

**Files:**
- Create: `lib/email/team-invitation-email.ts`

**Step 1: Create the email template**

Follow the pattern in `lib/email/lifecycle-emails.ts` using the `LifecycleEmail` component:

```typescript
import { LifecycleEmail } from "./templates/lifecycle";

type TeamInvitationEmailParams = {
  organizationName: string;
  invitedByName: string;
  inviteUrl: string;
  role: string;
};

/**
 * Email sent when someone is invited to join an organization.
 */
export function teamInvitationEmail(params: TeamInvitationEmailParams) {
  const { organizationName, invitedByName, inviteUrl, role } = params;

  return {
    to: "", // Will be set by the caller
    subject: `${invitedByName} invited you to join ${organizationName}`,
    react: LifecycleEmail({
      organizationName,
      clientName: "", // Not client-facing
      projectName: "",
      heading: "You're Invited",
      previewText: `${invitedByName} invited you to join ${organizationName}`,
      paragraphs: [
        `${invitedByName} has invited you to join ${organizationName} as ${role === "admin" ? "an admin" : "a team member"}.`,
        "Click the link below to accept the invitation and get started.",
        "This invitation expires in 30 days.",
      ],
      ctaLabel: "Accept Invitation",
      ctaUrl: inviteUrl,
    }),
  };
}
```

Note: The `to` field is empty here because `sendEmail` in the invitations route passes it directly. Check the actual calling pattern in Task 3 — you may need to set `to: email` on the invitation object before passing to `sendEmail`. Adjust the calling code so it looks like:

```typescript
await sendEmail(
  {
    ...teamInvitationEmail({ ... }),
    to: email,  // recipient's email
  },
  { ... }
);
```

**Step 2: Commit**

```bash
git add lib/email/team-invitation-email.ts
git commit -m "feat: add team invitation email template"
```

---

## Task 7: Org switcher — add Team link

**Files:**
- Modify: `components/layout/org-switcher.tsx` (lines 177-186)

**Step 1: Add Users import**

The `Users` icon is already imported (line 14 in sidebar-nav, but not in org-switcher). Add it to the lucide imports in `org-switcher.tsx`:

```typescript
import { ChevronsUpDown, Plus, Building2, Check, Loader2, Settings, Users } from "lucide-react";
```

**Step 2: Add Team menu item after Settings**

After the Settings `DropdownMenuItem` (line 186), add:

```typescript
          <DropdownMenuItem
            className="gap-2 cursor-pointer"
            onClick={() => router.push("/team")}
          >
            <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
              <Users className="size-3" />
            </div>
            <span>Team</span>
          </DropdownMenuItem>
```

**Step 3: Commit**

```bash
git add components/layout/org-switcher.tsx
git commit -m "feat: add Team link to org switcher dropdown"
```

---

## Task 8: `/team` page — member list, invitations, join link

**Files:**
- Create: `app/(app)/team/page.tsx` (server component)
- Create: `app/(app)/team/team-content.tsx` (client component)

**Step 1: Create the server page**

`app/(app)/team/page.tsx`:

```typescript
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/permissions";
import { TeamContent } from "./team-content";

export default async function TeamPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;
  const isAdmin = isAdminRole(membership.role);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Manage your organization&apos;s team members and invitations.
        </p>
      </div>
      <TeamContent
        orgId={organization.id}
        orgName={organization.name}
        isAdmin={isAdmin}
        currentUserId={membership.id}
        currentRole={membership.role}
      />
    </div>
  );
}
```

**Step 2: Create the client component**

`app/(app)/team/team-content.tsx` — this is the main team management UI with:
- Member list with role management
- Invite member form
- Pending invitations
- Join link management

This is a large component. Key sections:

1. **State**: members, invitations, join link status, invite form
2. **Data fetching**: `useEffect` to load members + invitations + join link
3. **Member list**: table with name, email, role (dropdown for admins), remove button
4. **Invite form**: email input + role select + send button
5. **Pending invitations**: list with resend/revoke
6. **Join link**: toggle + copy + regenerate

The implementation should use:
- `Card` with `squircle` class for sections
- `Select` for role dropdowns
- `Button` with confirmation `AlertDialog` for destructive actions (remove member, revoke invitation)
- `toast` from `sonner` for success/error notifications
- Copy to clipboard for join link

**Step 3: Commit**

```bash
git add app/\(app\)/team/
git commit -m "feat: add /team page with member list, invitations, and join link"
```

---

## Task 9: Remove Team tab from Settings

**Files:**
- Modify: `app/(app)/settings/page.tsx`
- Modify: `app/(app)/settings/settings-tabs.tsx`

**Step 1: Remove team tab from settings-tabs.tsx**

Remove the `teamContent` prop, `TabsTrigger`, and `TabsContent` for team.

**Step 2: Remove team content from settings page.tsx**

Remove the `teamContent` variable (lines 112-132) and the prop from `<SettingsTabs>`.

**Step 3: Commit**

```bash
git add app/\(app\)/settings/
git commit -m "refactor: remove team tab from settings (moved to /team)"
```

---

## Task 10: Project members API — assign/remove members from projects

**Files:**
- Create: `app/api/v1/organizations/[orgId]/projects/[projectId]/members/route.ts`

**Step 1: Create project members route (GET, POST, DELETE)**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectMembers, projects, memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET - list project members
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const members = await db.query.projectMembers.findMany({
      where: eq(projectMembers.projectId, projectId),
      with: {
        user: { columns: { id: true, name: true, email: true } },
      },
    });

    return NextResponse.json({
      members: members.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        assignedAt: m.createdAt,
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching project members:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST - assign a member to the project
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // Verify user is a member of the org
    const orgMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId)
      ),
    });

    if (!orgMembership) {
      return NextResponse.json(
        { error: "User is not a member of this organization" },
        { status: 400 }
      );
    }

    // Check if already assigned
    const existing = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: "User is already assigned to this project" },
        { status: 409 }
      );
    }

    const [created] = await db
      .insert(projectMembers)
      .values({ projectId, userId })
      .returning();

    return NextResponse.json({ member: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error assigning project member:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE - remove a member from the project (userId in search params)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const userId = request.nextUrl.searchParams.get("userId");

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const [deleted] = await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId)
        )
      )
      .returning();

    if (!deleted) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error removing project member:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/projects/\[projectId\]/members/
git commit -m "feat: add project members API (assign, list, remove)"
```

---

## Task 11: Project dashboard — Team section

**Files:**
- Modify: `app/(app)/projects/[id]/project-dashboard.tsx`

**Step 1: Add a Team section to the project dashboard**

Add a new section to the project dashboard (similar to existing sections like Files, Expenses). Shows:
- List of assigned members
- Add member selector (Popover + Command pattern, following `ProjectSelector` conventions)
- Remove member button

Only shown to admins/owners. The member selector should list org members who are NOT already assigned.

**Step 2: Commit**

```bash
git add app/\(app\)/projects/\[id\]/project-dashboard.tsx
git commit -m "feat: add team member section to project dashboard"
```

---

## Task 12: API visibility filtering — entries, projects, clients, expenses

This is the most critical task. All org-scoped API routes need to respect project membership for `member` role users.

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/entries/route.ts`
- Modify: `app/api/v1/organizations/[orgId]/projects/route.ts` (the list route)
- Modify: `app/api/v1/organizations/[orgId]/clients/route.ts`
- Modify: `app/api/v1/organizations/[orgId]/expenses/route.ts`
- Modify: `app/api/v1/organizations/[orgId]/tasks/route.ts`

**Pattern for each route:**

After `requireOrg()`, call `getAccessibleProjectIds()` from `lib/auth/permissions.ts`. If it returns `null` (admin/owner), proceed as before. If it returns an array, add filtering:

```typescript
import { getAccessibleProjectIds } from "@/lib/auth/permissions";

// After requireOrg():
const accessibleProjectIds = await getAccessibleProjectIds(
  session.user.id,
  membership.role
);

// For entries: also filter to own entries only for members
if (accessibleProjectIds !== null) {
  // Force userId to be the current user (members can only see own entries)
  // Filter to only accessible projects
}
```

**Step 1: Update entries route**

In `app/api/v1/organizations/[orgId]/entries/route.ts`, after `requireOrg()`:

- For `member` role: force `userId` to `session.user.id` (ignore the `userId` query param — members can only see their own entries)
- Filter entries to only those with `projectId` in `accessibleProjectIds`

**Step 2: Update projects route**

In the projects list route: filter to only return projects the member is assigned to.

**Step 3: Update clients route**

Filter to only return clients that have at least one project the member is assigned to.

**Step 4: Update expenses route**

Filter to own expenses only, and only for assigned projects.

**Step 5: Update tasks route**

Filter to only tasks in assigned projects.

**Step 6: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/entries/route.ts \
       app/api/v1/organizations/\[orgId\]/projects/ \
       app/api/v1/organizations/\[orgId\]/clients/ \
       app/api/v1/organizations/\[orgId\]/expenses/ \
       app/api/v1/organizations/\[orgId\]/tasks/
git commit -m "feat: enforce project-scoped visibility for member role"
```

---

## Task 13: Guard admin-only routes

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/clients/route.ts` (POST)
- Modify: `app/api/v1/organizations/[orgId]/projects/route.ts` (POST)
- Modify: Various settings-related routes

**Step 1: Add `requireAdmin()` to creation routes**

Members should not be able to create clients or projects. Add `requireAdmin(membership.role)` to the POST handlers for:
- `/api/v1/organizations/[orgId]/clients` (POST)
- `/api/v1/organizations/[orgId]/projects` (POST — may need to check if this exists at the project-level route)

**Step 2: Add `requireAdmin()` to invoicing routes**

Members should not access invoice management. Add guards to invoice routes.

**Step 3: Handle the `Forbidden` error in the standard error handler**

```typescript
if (error instanceof Error && error.message === "Forbidden") {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

**Step 4: Commit**

```bash
git add app/api/v1/organizations/
git commit -m "feat: guard admin-only API routes for member role"
```

---

## Task 14: Existing members GET route — add `createdAt`

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/members/route.ts`

**Step 1: Add `createdAt` to the response**

The team page needs the joined date. Update the response shape:

```typescript
const members = orgMemberships.map((m) => ({
  id: m.user.id,
  name: m.user.name,
  email: m.user.email,
  role: m.role,
  joinedAt: m.createdAt.toISOString(),
}));
```

**Step 2: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/members/route.ts
git commit -m "feat: add joinedAt to members API response"
```

---

## Task 15: UI polish and integration testing

**Step 1: Verify the full invitation flow**

1. As owner, go to `/team`
2. Invite a new email address
3. Check that the invitation appears in pending list
4. Open the invitation link (from email or console log)
5. Accept the invitation
6. Verify the new member appears in the member list

**Step 2: Verify role management**

1. Change a member's role from member to admin
2. Verify they can now access settings
3. Change back to member
4. Verify they can only see assigned projects

**Step 3: Verify join link**

1. Enable join link
2. Copy and open in incognito
3. Sign up and join
4. Verify new member appears
5. Regenerate link, verify old link no longer works

**Step 4: Verify project assignment**

1. Go to a project dashboard
2. Assign a member to the project
3. Log in as that member
4. Verify they can only see assigned projects and their own time entries

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration test issues for team management"
```

---

## Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | Schema: `team_invitations`, `project_members`, org columns | None |
| 2 | Permission helpers (`lib/auth/permissions.ts`) | Task 1 |
| 3 | Team invitations API (CRUD) | Tasks 1, 2, 6 |
| 4 | Member management API (role, remove) | Tasks 1, 2 |
| 5 | Join link API + acceptance flow | Tasks 1, 2 |
| 6 | Team invitation email template | None |
| 7 | Org switcher — add Team link | None |
| 8 | `/team` page UI | Tasks 3, 4, 5 |
| 9 | Remove Team tab from Settings | Task 8 |
| 10 | Project members API | Tasks 1, 2 |
| 11 | Project dashboard Team section | Task 10 |
| 12 | API visibility filtering | Task 2 |
| 13 | Guard admin-only routes | Task 2 |
| 14 | Members API — add `createdAt` | None |
| 15 | Integration testing | All |
