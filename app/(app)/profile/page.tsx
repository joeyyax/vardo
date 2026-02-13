import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { ProfileContent } from "./profile-content";

export default async function ProfilePage() {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  // Check if user has a credential (password) account
  const credentialAccount = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.userId, session.user.id),
      eq(accounts.providerId, "credential")
    ),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <ProfileContent
        user={{
          id: session.user.id,
          name: session.user.name || "",
          email: session.user.email,
          image: session.user.image || null,
          twoFactorEnabled: !!(session.user as Record<string, unknown>).twoFactorEnabled,
          hasPassword: !!credentialAccount,
        }}
      />
    </div>
  );
}
