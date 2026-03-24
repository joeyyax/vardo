import Link from "next/link";
import { TerminalBlock } from "./terminal-block";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Layered background: gradient + dot pattern */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/[0.04] via-transparent to-transparent" />
      <div className="dot-pattern pointer-events-none absolute inset-0 opacity-40" />
      <div className="pointer-events-none absolute -top-40 right-1/4 h-[600px] w-[800px] rounded-full bg-primary/[0.03] blur-[100px]" />
      {/* Fade out the dot pattern at the bottom */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />

      <div className="relative mx-auto flex min-h-[90vh] max-w-6xl items-center justify-center px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-3xl text-center">
          <h1 className="text-5xl font-extrabold tracking-tight text-foreground sm:text-6xl lg:text-7xl xl:text-8xl">
            <span className="block">
              Deploy on{" "}
              <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                your terms.
              </span>
            </span>
            <span className="mt-2 block text-3xl font-semibold text-muted-foreground sm:text-4xl lg:text-5xl xl:text-6xl">
              Not someone else&apos;s.
            </span>
          </h1>
          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps. Push
            your code, get HTTPS, backups, and monitoring — without learning
            Kubernetes or paying for PaaS.
          </p>
          <div className="mt-10">
            <Link
              href="/docs/getting-started"
              className="inline-flex h-12 items-center rounded-xl bg-primary px-8 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30"
            >
              Get Started
            </Link>
          </div>
          <div className="mx-auto mt-14 max-w-xl">
            <p className="mb-3 text-sm font-medium text-muted-foreground/70">
              Install on any Ubuntu or Debian server in under five minutes
            </p>
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
        </div>
      </div>
    </section>
  );
}
