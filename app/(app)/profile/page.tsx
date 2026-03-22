import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { GitHubConnection } from "./github-connection";

export default async function ProfilePage() {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account and connected services.
        </p>
      </div>

      <GitHubConnection />
    </div>
  );
}
