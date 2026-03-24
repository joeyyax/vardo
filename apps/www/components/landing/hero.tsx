import Link from "next/link";
import { TerminalBlock } from "./terminal-block";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Layered background */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-blue-500/[0.06] via-blue-500/[0.02] to-transparent" />
      <div className="dot-pattern pointer-events-none absolute inset-0 opacity-50" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[600px] w-[800px] -translate-x-1/2 rounded-full bg-blue-500/[0.06] blur-[120px]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-white dark:from-neutral-950 to-transparent" />

      <div className="relative mx-auto flex min-h-[90vh] max-w-7xl items-center justify-center px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-3xl text-center">
          <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl xl:text-8xl">
            <span className="block text-neutral-900 dark:text-neutral-100">
              Deploy on{" "}
              <span className="text-blue-600 dark:text-blue-400 underline decoration-blue-500/30 decoration-4 underline-offset-[6px]">
                your terms.
              </span>
            </span>
            <span className="mt-2 block text-3xl font-semibold text-neutral-500 dark:text-neutral-400 sm:text-4xl lg:text-5xl xl:text-6xl">
              Not someone else&apos;s.
            </span>
          </h1>
          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-neutral-500 dark:text-neutral-400 sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps. Push
            your code, get HTTPS, backups, and monitoring — without learning
            Kubernetes or paying for PaaS.
          </p>
          <div className="mt-10">
            <Link
              href="/docs/getting-started"
              className="inline-flex h-12 items-center rounded-xl bg-blue-600 dark:bg-blue-500 px-8 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-all duration-200 hover:bg-blue-700 dark:hover:bg-blue-600 hover:shadow-xl hover:shadow-blue-600/35 hover:-translate-y-0.5"
            >
              Get Started
            </Link>
          </div>
          <div className="mx-auto mt-14 max-w-xl">
            <p className="mb-3 text-sm font-medium text-neutral-400 dark:text-neutral-500">
              Install on any Ubuntu or Debian server in under five minutes
            </p>
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
        </div>
      </div>
    </section>
  );
}
