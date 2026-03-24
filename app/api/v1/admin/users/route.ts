import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireAppAdmin } from "@/lib/auth/admin";

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
// Invite a user — creates account, sends magic link for first login
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

    // Create user directly — no password (users sign in via magic link or passkey)
    const userId = nanoid();

    await db.insert(user).values({
      id: userId,
      email: normalizedEmail,
      name: name || normalizedEmail.split("@")[0],
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Send invitation with magic link
    let emailSent = false;
    try {
      const { sendEmail } = await import("@/lib/email/send");
      const { InviteEmail } = await import("@/lib/email/templates/invite");
      await sendEmail({
        to: normalizedEmail,
        subject: `You've been invited to ${(await import("@/lib/app-name")).DEFAULT_APP_NAME}`,
        template: InviteEmail({ email: normalizedEmail }),
      });
      emailSent = true;
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
        emailSent,
        message: emailSent
          ? "Invitation email sent. User can sign in via magic link."
          : "User created. Share the login URL — they can sign in via magic link.",
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error creating user");
  }
}
