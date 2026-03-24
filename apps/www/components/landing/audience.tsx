import { Section } from "./section";

const builtFor = [
  {
    label: "Solo devs and small teams",
    aside: "You want to own your stack without hiring a DevOps person.",
  },
  {
    label: "Side projects that got real",
    aside: "You outgrew Heroku's free tier, the cold starts, and the 30-second request timeouts.",
  },
  {
    label: "Agencies juggling client apps",
    aside: "One server, many projects. Each with its own domain, env, and deploy pipeline.",
  },
  {
    label: "Anyone tired of per-seat pricing",
    aside: "Your server costs the same whether you have 2 team members or 20.",
  },
];

const notFor = [
  {
    label: "you need scale-to-zero or auto-scaling",
    aside: "We don't. But your containers are always warm. No cold starts, no spin-up latency.",
  },
  {
    label: "you need a managed database",
    aside: "We'll run your Postgres or Redis just fine. But replication, failover, connection pooling — that's PlanetScale or Neon territory.",
  },
  {
    label: "you need file or object storage",
    aside: "Uploads, media, assets — that stuff belongs in R2 or S3, not on your server's disk.",
  },
  {
    label: "you need edge compute",
    aside: "We run on your servers — but we play great with Cloudflare Workers, CDNs, and edge caching in front.",
  },
];

export function Audience() {
  return (
    <Section>
      <h2 className="mb-10 text-center text-2xl font-bold tracking-tight text-neutral-500 sm:text-3xl">
        Right tool, right job.
      </h2>
      <div className="grid gap-0 lg:grid-cols-2">
        {/* Built for — welcoming, confident */}
        <div className="rounded-2xl rounded-b-none border border-neutral-800 border-b-0 bg-neutral-900/50 p-10 lg:rounded-r-none lg:rounded-l-2xl lg:border-b lg:border-r-0 sm:p-12">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
            Who this is for
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            You. <em className="font-normal italic text-neutral-400">Probably.</em>
          </h2>
          <div className="mt-10 space-y-8">
            {builtFor.map((item) => (
              <div key={item.label} className="flex items-start gap-4">
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
                  className="mt-0.5 shrink-0 text-white"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <div>
                  <span className="text-lg leading-snug text-neutral-200">
                    {item.label}
                  </span>
                  <p className="mt-1 font-mono text-sm text-neutral-500">
                    {item.aside}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Not for — honest, a little cheeky */}
        <div className="rounded-2xl rounded-t-none border border-neutral-800 bg-neutral-950 p-10 lg:rounded-l-none lg:rounded-r-2xl lg:rounded-t-2xl lg:border-l-0 sm:p-12">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-600">
            Who this isn&apos;t for
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-neutral-500 sm:text-4xl">
            Maybe not for you, if...
          </h2>
          <div className="mt-10 space-y-8">
            {notFor.map((item) => (
              <div key={item.label}>
                <div className="flex items-start gap-4">
                  <span className="mt-1.5 block size-4 shrink-0 text-neutral-700">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </span>
                  <div>
                    <span className="text-lg leading-snug text-neutral-400">
                      {item.label}
                    </span>
                    <p className="mt-1 font-mono text-sm text-neutral-600">
                      {item.aside}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
