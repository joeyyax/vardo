import Link from "next/link";
import { Section } from "./section";
import { TerminalBlock } from "./terminal-block";
import { INSTALL_COMMAND } from "@/lib/constants";

export function InstallCta() {
  return (
    <Section>
      {/* Rainbow border container */}
      <div className="relative mx-auto max-w-3xl rounded-2xl p-px">
        {/* Animated gradient border */}
        <div
          className="absolute inset-0 rounded-2xl opacity-60"
          style={{
            background:
              "linear-gradient(135deg, #34d399, #38bdf8, #a78bfa, #fb7185, #fbbf24, #2dd4bf)",
            backgroundSize: "300% 300%",
            animation: "gradient-shift 8s ease infinite",
          }}
        />
        {/* Inner content */}
        <div className="relative rounded-2xl bg-neutral-950 px-8 py-14 sm:px-14 sm:py-20">
          <div className="text-center">
            <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl lg:text-5xl">
              Five minutes from now,
              <br />
              you&apos;ll have your own PaaS
            </h2>
            <p className="mt-5 text-lg text-neutral-400">
              One command. One server. Everything you need.
            </p>
            <div className="mx-auto mt-10 max-w-xl">
              <TerminalBlock command={INSTALL_COMMAND} />
            </div>
            <p className="mt-6 text-sm text-neutral-500">
              Requires Ubuntu 22.04+ or Debian 12+. 1 GB RAM. A domain with DNS
              pointed to your server.
            </p>
            <Link
              href="/docs/installation"
              className="mt-4 inline-block text-sm font-medium text-neutral-300 transition-colors duration-150 hover:text-white"
            >
              See the full installation guide &rarr;
            </Link>
          </div>
        </div>
      </div>
    </Section>
  );
}
