import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { user, account } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { randomBytes, createHash } from "crypto";

// Hash password with bcrypt-compatible approach via Better Auth's internal method
// Since Better Auth uses its own password hashing, we'll use the auth API to create users
import { auth } from "@/lib/auth";

async function requireAppAdmin() {
  const session = await requireSession();
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });
  if (!dbUser?.isAppAdmin) {
    throw new Error("Forbidden");
  }
  return session;
}

// GET /api/v1/admin/users
// List all users (admin only)
export async function GET() {
  try {
    await requireAppAdmin();

    const users = await db.query.user.findMany({
      columns: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        isAppAdmin: true,
        twoFactorEnabled: true,
        createdAt: true,
      },
      orderBy: (u, { desc }) => [desc(u.createdAt)],
    });

    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: u.emailVerified,
        isAppAdmin: u.isAppAdmin,
        twoFactorEnabled: u.twoFactorEnabled,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching users");
  }
}

// POST /api/v1/admin/users
// Invite a user by creating their account with a temporary password
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const { email, name } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existing = await db.query.user.findFirst({
      where: eq(user.email, normalizedEmail),
      columns: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 409 }
      );
    }

    // Generate a temporary password
    const tempPassword = randomBytes(12).toString("base64url");

    // Create user via Better Auth's server-side API
    // This handles password hashing internally
    try {
      const newUser = await auth.api.signUpEmail({
        body: {
          email: normalizedEmail,
          password: tempPassword,
          name: name || normalizedEmail.split("@")[0],
        },
      });

      // Try to send an invitation email
      try {
        const { sendEmail } = await import("@/lib/email/send");
        const { InviteEmail } = await import("@/lib/email/templates/invite");
        await sendEmail({
          to: normalizedEmail,
          subject: "You've been invited to Host",
          template: InviteEmail({
            email: normalizedEmail,
            tempPassword,
          }),
        });
      } catch (emailError) {
        console.log("[admin] Email sending skipped or failed:", emailError);
        // Email sending is optional -- return the temp password in the response
      }

      return NextResponse.json(
        {
          user: {
            id: newUser.user?.id,
            email: normalizedEmail,
            name: name || normalizedEmail.split("@")[0],
          },
          tempPassword,
        },
        { status: 201 }
      );
    } catch (signupError: unknown) {
      // Better Auth's signUpEmail may reject because disableSignUp is true.
      // Fall back to direct database insertion.
      const userId = nanoid();
      const accountId = nanoid();

      // Hash the password using the same approach Better Auth uses (bcrypt via Web Crypto)
      const { hashPassword } = await import("better-auth/crypto");
      const hashedPassword = await hashPassword(tempPassword);

      await db.insert(user).values({
        id: userId,
        email: normalizedEmail,
        name: name || normalizedEmail.split("@")[0],
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.insert(account).values({
        id: accountId,
        accountId: userId,
        providerId: "credential",
        userId,
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Try to send invitation email
      try {
        const { sendEmail } = await import("@/lib/email/send");
        const { InviteEmail } = await import("@/lib/email/templates/invite");
        await sendEmail({
          to: normalizedEmail,
          subject: "You've been invited to Host",
          template: InviteEmail({
            email: normalizedEmail,
            tempPassword,
          }),
        });
      } catch (emailError) {
        console.log("[admin] Email sending skipped or failed:", emailError);
      }

      return NextResponse.json(
        {
          user: {
            id: userId,
            email: normalizedEmail,
            name: name || normalizedEmail.split("@")[0],
          },
          tempPassword,
        },
        { status: 201 }
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error creating user");
  }
}
