import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    redirect("/login?redirect=/portal");
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-4">
          <Link
            href="/portal"
            className="flex items-center gap-2 font-semibold"
          >
            <span className="text-lg">Client Portal</span>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <form action="/api/auth/signout" method="POST">
            <Button variant="ghost" size="sm" type="submit">
              <LogOut className="size-4" />
              <span className="sr-only">Sign out</span>
            </Button>
          </form>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-4 lg:p-6">{children}</main>

      {/* Footer */}
      <footer className="border-t py-4 text-center text-sm text-muted-foreground">
        <p>Client Portal</p>
      </footer>
    </div>
  );
}
