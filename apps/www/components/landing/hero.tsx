import Link from "next/link";
import { TerminalBlock } from "./terminal-block";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Subtle gradient background */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/[0.04] via-transparent to-transparent" />
      <div className="pointer-events-none absolute -top-24 right-0 h-[500px] w-[700px] rounded-full bg-primary/[0.03] blur-3xl" />

      <div className="relative mx-auto flex min-h-[85vh] max-w-6xl items-center px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl xl:text-7xl">
            <span className="block">Deploy on</span>
            <span className="block">your server.</span>
            <span className="block text-muted-foreground">
              Not someone else&apos;s.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps. Push
            your code, get HTTPS, backups, and monitoring — without learning
            Kubernetes or paying for PaaS.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link
              href="/docs/getting-started"
              className="inline-flex h-11 items-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
            >
              Get Started
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-11 items-center rounded-lg border border-border px-6 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted"
            >
              Documentation
            </Link>
            <Link
              href="https://github.com/joeyyax/vardo"
              className="inline-flex h-11 items-center rounded-lg border border-border px-6 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted"
            >
              GitHub
            </Link>
          </div>
          <div className="mt-10 max-w-xl">
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
        </div>
      </div>
    </section>
  );
}
