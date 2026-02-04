import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Clock, Zap, FileText, Shield } from "lucide-react";

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
      <main className="container mx-auto px-4 pt-20 pb-32">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            Time tracking that gets out of your way
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Quick manual entry, smart suggestions, and clean reports. Built for
            freelancers and small teams who&apos;d rather be working than fiddling
            with timers.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild className="squircle rounded-xl h-12 px-8">
              <Link href="/login">Start tracking free</Link>
            </Button>
          </div>
        </div>

        {/* Features */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-24 max-w-5xl mx-auto">
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
            icon={<FileText className="w-5 h-5" />}
            title="Client reports"
            description="Share progress with clients via simple links. No accounts needed."
          />
          <FeatureCard
            icon={<Shield className="w-5 h-5" />}
            title="Your data"
            description="Export anytime. API access included. No lock-in, ever."
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
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
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
