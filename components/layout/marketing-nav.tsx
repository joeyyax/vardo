import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Brand } from "../brand";

export function MarketingNav() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b bg-background/80 backdrop-blur-sm">
      <div className="container mx-auto px-4 h-14">
        <div className="grid grid-cols-3 items-center h-full">
          {/* Left: Logo */}
          <Brand />

          {/* Center: Nav */}
          <nav className="hidden lg:flex items-center justify-center gap-6 text-sm">
            <Link
              href="/how-it-works"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              How it works
            </Link>
            <Link
              href="/for-you"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Who it&apos;s for
            </Link>
            <Link
              href="/why"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Why
            </Link>
            <Link
              href="/pricing"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Pricing
            </Link>
          </nav>

          {/* Right: Buttons */}
          <div className="flex items-center justify-end gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/login">Build your workflow</Link>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
