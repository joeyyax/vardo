import Link from "next/link";

import { Brand } from "../brand";

export function MarketingFooter() {
  return (
    <footer className="border-t py-16 px-4 bg-secondary/20">
      <div className="container mx-auto">
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          <div>
            <Brand />
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Product</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link
                  href="/how-it-works"
                  className="hover:text-foreground transition-colors"
                >
                  How it works
                </Link>
              </li>
              <li>
                <Link
                  href="/for-you"
                  className="hover:text-foreground transition-colors"
                >
                  Who it&apos;s for
                </Link>
              </li>
              <li>
                <Link
                  href="/pricing"
                  className="hover:text-foreground transition-colors"
                >
                  Pricing
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Philosophy</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link
                  href="/why"
                  className="hover:text-foreground transition-colors"
                >
                  Why Scope exists
                </Link>
              </li>
              <li>
                <Link
                  href="/choosing-the-right-tool"
                  className="hover:text-foreground transition-colors"
                >
                  Choosing the right tool
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Account</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link
                  href="/login"
                  className="hover:text-foreground transition-colors"
                >
                  Sign in
                </Link>
              </li>
              <li>
                <Link
                  href="/privacy"
                  className="hover:text-foreground transition-colors"
                >
                  Privacy
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="hover:text-foreground transition-colors"
                >
                  Terms
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Scope. All rights reserved.
          </p>
          <p className="text-sm text-muted-foreground">
            Built for freelancers and small teams.
          </p>
        </div>
      </div>
    </footer>
  );
}
