import Link from "next/link";
import { Section } from "./section";
import { TerminalBlock } from "./terminal-block";

export function InstallCta() {
  return (
    <div className="bg-muted/50">
      <Section>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Ready to deploy?
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            One command. Five minutes. Your own PaaS.
          </p>
          <div className="mx-auto mt-10 max-w-xl">
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Requires Ubuntu 22.04+ or Debian 12+. 1 GB RAM. A domain with DNS
            pointed to your server.
          </p>
          <Link
            href="/docs/installation"
            className="mt-4 inline-block text-sm font-medium text-primary transition-colors duration-150 hover:text-primary/80"
          >
            See the full installation guide &rarr;
          </Link>
        </div>
      </Section>
    </div>
  );
}
