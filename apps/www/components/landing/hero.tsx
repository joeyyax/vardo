import Link from "next/link";
import { TerminalBlock } from "./terminal-block";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="relative mx-auto flex min-h-[90vh] max-w-7xl items-center justify-center px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-3xl text-center">
          <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl xl:text-8xl">
            <span className="block text-white">
              Deploy on{" "}
              <span className="text-blue-500">your terms.</span>
            </span>
            <span className="mt-2 block text-3xl font-semibold text-neutral-400 sm:text-4xl lg:text-5xl xl:text-6xl">
              Not someone else&apos;s.
            </span>
          </h1>
          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-neutral-300 sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps. Push
            your code, get HTTPS, backups, and monitoring — without learning
            Kubernetes or paying for PaaS.
          </p>
          <div className="mt-10">
            <Link
              href="/docs/getting-started"
              className="inline-flex h-12 items-center rounded-xl bg-blue-500 px-8 text-sm font-semibold text-white transition-all duration-200 hover:bg-blue-600 hover:-translate-y-0.5"
            >
              Get Started
            </Link>
          </div>
          <div className="mx-auto mt-14 max-w-xl">
            <p className="mb-3 text-sm font-medium text-neutral-500">
              Install on any Ubuntu or Debian server in under five minutes
            </p>
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
        </div>
      </div>
    </section>
  );
}
