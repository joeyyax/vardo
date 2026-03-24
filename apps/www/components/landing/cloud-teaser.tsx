import { Section } from "./section";

export function CloudTeaser() {
  return (
    <Section className="bg-muted/30">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Self-hosted or managed — your choice
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">
          Run Vardo on your own hardware with full control, or let us handle the
          infrastructure.
        </p>
      </div>
      <div className="mx-auto mt-12 grid max-w-4xl gap-6 sm:grid-cols-2">
        {/* Self-hosted */}
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary"
            >
              <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
              <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-foreground">Self-hosted</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Install on any Ubuntu or Debian server. Full root access, your
            data stays on your hardware, export and move anytime.
          </p>
          <p className="mt-3 text-sm font-medium text-primary">
            Available now
          </p>
        </div>
        {/* Managed cloud */}
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary"
            >
              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-foreground">
            Vardo Cloud
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Same Vardo experience, managed for you. We handle provisioning,
            updates, and backups so you can focus on shipping.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Coming soon at{" "}
            <span className="font-medium text-foreground">vardo.cloud</span>
          </p>
        </div>
      </div>
    </Section>
  );
}
