import Link from "next/link";
import { Section } from "./section";
import { TerminalBlock } from "./terminal-block";

export function InstallCta() {
  return (
    <Section>
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Five minutes from now,
          <br />
          you&apos;ll have your own PaaS
        </h2>
        <p className="mt-4 text-lg text-neutral-400">
          One command. One server. Everything you need.
        </p>
        <div className="mx-auto mt-10 max-w-xl">
          <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
        </div>
        <p className="mt-6 text-sm text-neutral-500">
          Requires Ubuntu 22.04+ or Debian 12+. 1 GB RAM. A domain with DNS
          pointed to your server.
        </p>
        <Link
          href="/docs/installation"
          className="mt-4 inline-block text-sm font-medium text-emerald-500 transition-colors duration-150 hover:text-emerald-400"
        >
          See the full installation guide &rarr;
        </Link>
      </div>
    </Section>
  );
}
