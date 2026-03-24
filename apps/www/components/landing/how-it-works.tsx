import { Section } from "./section";

const steps = [
  {
    number: "01",
    title: "Install",
    description:
      "One command sets up Vardo, Traefik, PostgreSQL, and Redis on your server.",
    code: "curl -fsSL https://vardo.run/install.sh | sudo bash",
  },
  {
    number: "02",
    title: "Create a project",
    description:
      "Add your app from Git, a Docker image, or a template. Configure domains and env vars.",
  },
  {
    number: "03",
    title: "Deploy",
    description:
      "Hit deploy. Vardo builds, health-checks, routes traffic, and provisions TLS. You're live.",
  },
];

export function HowItWorks() {
  return (
    <Section>
      <div className="mb-16">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          From zero to production
          <br />
          in three steps
        </h2>
      </div>
      <div className="space-y-16 sm:space-y-20">
        {steps.map((step) => (
          <div key={step.number} className="relative grid gap-6 sm:grid-cols-[120px_1fr] sm:gap-10">
            <div className="relative">
              <span className="text-7xl font-bold leading-none text-white/[0.07] sm:text-8xl">
                {step.number}
              </span>
            </div>
            <div>
              <h3 className="text-xl font-semibold text-white">
                {step.title}
              </h3>
              <p className="mt-2 max-w-lg text-neutral-400">
                {step.description}
              </p>
              {step.code && (
                <div className="mt-4 inline-block overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.04] px-4 py-3 font-mono text-sm text-neutral-300">
                  <span className="select-none text-emerald-400">$ </span>
                  {step.code}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
