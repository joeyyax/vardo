import { Section } from "./section";

const steps = [
  {
    number: "1",
    title: "Install",
    description:
      "One command sets up Vardo, Traefik, PostgreSQL, and Redis on your server.",
    code: "curl -fsSL https://vardo.run/install.sh | sudo bash",
  },
  {
    number: "2",
    title: "Create a project",
    description:
      "Add your app from Git, a Docker image, or a template. Configure domains and env vars.",
  },
  {
    number: "3",
    title: "Deploy",
    description:
      "Hit deploy. Vardo builds, health-checks, routes traffic, and provisions TLS. You're live.",
  },
];

export function HowItWorks() {
  return (
    <Section>
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          From zero to production in three commands
        </h2>
      </div>
      <div className="mt-16 grid gap-10 sm:grid-cols-3">
        {steps.map((step) => (
          <div key={step.number} className="relative">
            <span className="text-4xl font-bold text-primary/20">
              {step.number}
            </span>
            <h3 className="mt-3 text-lg font-semibold text-foreground">
              {step.title}
            </h3>
            <p className="mt-2 text-muted-foreground">{step.description}</p>
            {step.code && (
              <div className="mt-4 overflow-x-auto rounded-lg bg-neutral-950 px-4 py-3 font-mono text-sm text-neutral-300">
                <span className="select-none text-emerald-400">$ </span>
                {step.code}
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
