import { Section } from "./section";

const features = [
  {
    title: "Ship in minutes, not hours",
    description:
      "Push from Git, pull a Docker image, or paste a Compose file. Blue-green deployments with zero-downtime rollback — your app is live before you take your next sip.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  },
  {
    title: "HTTPS without the headache",
    description:
      "Custom domains with automatic TLS via Let's Encrypt. Wildcard subdomains out of the box — no cert wrangling, no Nginx configs.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        <circle cx="12" cy="16" r="1" />
      </svg>
    ),
  },
  {
    title: "Sleep through the night",
    description:
      "Automated volume snapshots to S3, R2, or B2. Tiered retention and one-click restore — so a bad deploy never means lost data.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
        <polyline points="12 12 12 8" />
        <polyline points="12 12 15 14" />
      </svg>
    ),
  },
  {
    title: "Know before your users do",
    description:
      "Container metrics, log aggregation, and health checks built in. See problems the moment they start — no Grafana stack required.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
  },
];

export function Features() {
  return (
    <Section className="bg-muted/30">
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Everything you need to run production apps
        </h2>
      </div>
      <div className="mt-16 grid gap-6 sm:grid-cols-2">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-xl border border-border bg-card p-6 transition-colors duration-200 hover:border-primary/50"
          >
            <div className="mb-4 text-primary">{feature.icon}</div>
            <h3 className="text-lg font-semibold text-foreground">
              {feature.title}
            </h3>
            <p className="mt-2 text-muted-foreground">{feature.description}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
