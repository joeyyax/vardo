import Link from "next/link";
import { Section } from "./section";

export function CloudTeaser() {
  return (
    <Section>
      <div className="mb-12">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Self-hosted or managed
          <br />
          — your choice
        </h2>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:gap-8">
        {/* Self-hosted — primary */}
        <div className="rounded-xl border border-blue-500/30 bg-neutral-900 p-8">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-500">
            <span className="size-1.5 rounded-full bg-blue-500" />
            Available now
          </div>
          <h3 className="text-2xl font-bold text-white">Self-hosted</h3>
          <p className="mt-3 max-w-sm text-neutral-400">
            Install on any Ubuntu or Debian server. Full root access, your data
            stays on your hardware, export and move anytime.
          </p>
          <Link
            href="/docs/getting-started"
            className="mt-6 inline-flex h-10 items-center rounded-lg bg-blue-500 px-5 text-sm font-medium text-white transition-colors duration-150 hover:bg-blue-600"
          >
            Get Started
          </Link>
        </div>

        {/* Managed cloud — secondary */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-neutral-800 px-3 py-1 text-xs font-medium text-neutral-400">
            Coming soon
          </div>
          <h3 className="text-2xl font-bold text-white">Vardo Cloud</h3>
          <p className="mt-3 max-w-sm text-neutral-400">
            Same Vardo experience, managed for you. We handle provisioning,
            updates, and backups so you can focus on shipping.
          </p>
          <p className="mt-6 text-sm text-neutral-500">
            Launching at{" "}
            <span className="font-medium text-neutral-100">vardo.cloud</span>
          </p>
        </div>
      </div>
    </Section>
  );
}
