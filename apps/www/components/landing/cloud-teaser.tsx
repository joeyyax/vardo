import Link from "next/link";
import { Section } from "./section";

export function CloudTeaser() {
  return (
    <Section>
      <div className="mb-12">
        <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Self-hosted or managed
          <br />
          — your choice
        </h2>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:gap-8">
        {/* Self-hosted — primary */}
        <div className="relative overflow-hidden rounded-xl border-2 border-primary bg-primary/[0.04] p-8">
          <div className="absolute -right-8 -top-8 size-32 rounded-full bg-primary/[0.06] blur-2xl" />
          <div className="relative">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <span className="size-1.5 rounded-full bg-primary" />
              Available now
            </div>
            <h3 className="text-2xl font-bold text-foreground">Self-hosted</h3>
            <p className="mt-3 max-w-sm text-muted-foreground">
              Install on any Ubuntu or Debian server. Full root access, your data
              stays on your hardware, export and move anytime.
            </p>
            <Link
              href="/docs/getting-started"
              className="mt-6 inline-flex h-10 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
            >
              Get Started
            </Link>
          </div>
        </div>

        {/* Managed cloud — secondary */}
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground">
            Coming soon
          </div>
          <h3 className="text-2xl font-bold text-foreground">Vardo Cloud</h3>
          <p className="mt-3 max-w-sm text-muted-foreground">
            Same Vardo experience, managed for you. We handle provisioning,
            updates, and backups so you can focus on shipping.
          </p>
          <p className="mt-6 text-sm text-muted-foreground">
            Launching at{" "}
            <span className="font-medium text-foreground">vardo.cloud</span>
          </p>
        </div>
      </div>
    </Section>
  );
}
