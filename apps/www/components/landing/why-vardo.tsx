import { Section } from "./section";

const differentiators = [
  "Docker Compose native — no proprietary abstractions",
  "Your server, your data, your config",
  "No vendor lock-in — Git, Docker, S3, Let's Encrypt",
  "Backups, monitoring, TLS, blue-green deploys — all built in",
  "One install, full stack — Traefik, PostgreSQL, Redis, logs",
];

export function WhyVardo() {
  return (
    <Section>
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Your infrastructure,
            <br />
            your way
          </h2>
          <p className="mt-6 max-w-lg text-lg text-muted-foreground">
            Most self-hosted PaaS tools are either too simple — no backups, no
            monitoring — or too complex — Kubernetes in disguise. Vardo sits in
            the sweet spot: everything you need, nothing you don&apos;t.
          </p>
        </div>
        <div className="flex flex-col justify-center">
          <div className="space-y-5">
            {differentiators.map((item) => (
              <div key={item} className="flex items-start gap-3">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 shrink-0 text-primary"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="text-lg font-medium text-foreground">
                  {item}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
