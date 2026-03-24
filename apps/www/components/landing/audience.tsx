import { Section } from "./section";

const builtFor = [
  "Solo devs and small teams who want to own their stack",
  "Side projects that outgrew Heroku's free tier",
  "Agencies managing client apps across servers",
  "Anyone who's done paying per-seat for infrastructure",
];

const notFor = [
  "Kubernetes-scale orchestration — we run Compose, not clusters",
  "Serverless or edge functions — your containers stay running",
  "Multi-tenant SaaS hosting — this is for your apps, not your customers'",
  "People who want zero ops — that's what Vardo Cloud will be for",
];

export function Audience() {
  return (
    <Section>
      <div className="grid gap-16 lg:grid-cols-2 lg:gap-20">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Who this is for
          </h2>
          <div className="mt-8 space-y-4">
            {builtFor.map((item) => (
              <div key={item} className="flex items-start gap-3">
                <span className="mt-1.5 block size-1.5 shrink-0 rounded-full bg-emerald-400" />
                <span className="text-lg text-neutral-300">{item}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Who this isn&apos;t for
          </h2>
          <p className="mt-4 text-sm text-neutral-500">
            Honest about our limits. Not every tool is for every job.
          </p>
          <div className="mt-8 space-y-4">
            {notFor.map((item) => (
              <div key={item} className="flex items-start gap-3">
                <span className="mt-1.5 block size-1.5 shrink-0 rounded-full bg-neutral-600" />
                <span className="text-lg text-neutral-400">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
