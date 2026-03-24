import { Section } from "./section";

const differentiators = [
  {
    title: "Docker Compose native",
    description:
      "No proprietary abstractions. Your compose files work as-is.",
  },
  {
    title: "Own your infrastructure",
    description:
      "Your server, your data, your config. Export everything, move anywhere.",
  },
  {
    title: "No vendor lock-in",
    description:
      "Every component is standard: Git, Docker, S3, WireGuard, Let's Encrypt.",
  },
  {
    title: "Batteries included",
    description:
      "Backups, monitoring, TLS, environments, blue-green deploys. All built in.",
  },
  {
    title: "One install, full stack",
    description:
      "Traefik, PostgreSQL, Redis, log aggregation. One command.",
  },
];

export function WhyVardo() {
  return (
    <Section className="bg-muted/30">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Your infrastructure, your way
          </h2>
          <p className="mt-6 text-lg text-muted-foreground">
            Most self-hosted PaaS tools are either too simple — no backups, no
            monitoring — or too complex — Kubernetes in disguise. Vardo sits in
            the sweet spot: everything you need, nothing you don&apos;t.
          </p>
        </div>
        <div>
          {differentiators.map((item, index) => (
            <div
              key={item.title}
              className={`py-3 ${index < differentiators.length - 1 ? "border-b border-border" : ""}`}
            >
              <h3 className="font-semibold text-foreground">{item.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
