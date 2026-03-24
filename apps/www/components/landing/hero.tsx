import Link from "next/link";
import { TerminalBlock } from "./terminal-block";

export function Hero() {
  return (
    <section className="flex min-h-[85vh] items-center">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-7xl">
            Deploy on your server.
            <br />
            Not someone else&apos;s.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps. Push your
            code, get HTTPS, backups, and monitoring — without learning
            Kubernetes or paying for PaaS.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
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
          <div className="mx-auto mt-12 max-w-xl">
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
        </div>
      </div>
    </section>
  );
}
