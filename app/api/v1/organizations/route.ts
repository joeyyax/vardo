import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizations, memberships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";

/**
 * POST /api/v1/organizations
 * Create a new organization for the authenticated user.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Organization name is required" },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();

    // Generate a slug from the name
    const baseSlug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Add a random suffix to ensure uniqueness
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;

    // Create the organization
    const [org] = await db
      .insert(organizations)
      .values({
        name: trimmedName,
        slug,
        roundingIncrement: 15, // default 15 minutes
      })
      .returning();

    // Create the membership (user is owner)
    await db.insert(memberships).values({
      userId: session.user.id,
      organizationId: org.id,
      role: "owner",
    });

    return NextResponse.json({ organization: org }, { status: 201 });
  } catch (error) {
    console.error("Error creating organization:", error);
    return NextResponse.json(
      { error: "Failed to create organization" },
      { status: 500 }
    );
  }
}
