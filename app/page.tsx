import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Clock,
  Zap,
  FileText,
  Shield,
  Receipt,
  Users,
  ArrowRightLeft,
} from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      {/* Header */}
      <header className="container mx-auto px-4 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-6 h-6 text-primary" />
          <span className="font-semibold text-lg">Time</span>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild className="squircle rounded-lg">
            <Link href="/login">Get started</Link>
          </Button>
        </div>
      </header>

      {/* Hero */}
      <main className="container mx-auto px-4 pt-16 pb-24">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            Time tracking that gets out of your way
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Quick manual entry, invoicing, and clean reports. Built for
            freelancers and small teams who&apos;d rather be working than
            fiddling with timers.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild className="squircle rounded-xl h-12 px-8">
              <Link href="/login">Start tracking free</Link>
            </Button>
          </div>
        </div>

        {/* Primary Features */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-20 max-w-4xl mx-auto">
          <FeatureCard
            icon={<Zap className="w-5 h-5" />}
            title="Quick entry"
            description="Keyboard-first design. Log time in seconds without touching your mouse."
          />
          <FeatureCard
            icon={<Clock className="w-5 h-5" />}
            title="No timers"
            description="Just enter what you did and how long it took. Simple as that."
          />
          <FeatureCard
            icon={<Receipt className="w-5 h-5" />}
            title="Invoicing"
            description="Generate invoices from tracked time. Send shareable links to clients."
          />
        </div>

        {/* Secondary Features */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-6 max-w-4xl mx-auto">
          <FeatureCard
            icon={<Users className="w-5 h-5" />}
            title="Client management"
            description="Organize clients, projects, and tasks with flexible billing rates."
            compact
          />
          <FeatureCard
            icon={<FileText className="w-5 h-5" />}
            title="Reports"
            description="Share progress with clients via links. No accounts needed."
            compact
          />
          <FeatureCard
            icon={<ArrowRightLeft className="w-5 h-5" />}
            title="Toggl import"
            description="Switching from Toggl? Import your existing data in minutes."
            compact
          />
          <FeatureCard
            icon={<Shield className="w-5 h-5" />}
            title="Your data"
            description="Export anytime. Full API access. No lock-in, ever."
            compact
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="container mx-auto px-4 py-8 border-t">
        <p className="text-center text-sm text-muted-foreground">
          Built for people who track time to bill clients, not to micromanage.
        </p>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
  compact,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="p-4 rounded-xl squircle bg-card border">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg squircle bg-primary/10 flex items-center justify-center text-primary shrink-0">
            {icon}
          </div>
          <h3 className="font-medium text-sm">{title}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    );
  }

  return (
    <div className="p-6 rounded-2xl squircle bg-card border">
      <div className="w-10 h-10 rounded-xl squircle bg-primary/10 flex items-center justify-center text-primary mb-4">
        {icon}
      </div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
