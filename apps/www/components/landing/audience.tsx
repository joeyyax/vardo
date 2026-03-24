import { Section } from "./section";

const builtFor = [
  "Solo devs and small teams who want to own their stack",
  "Side projects that outgrew Heroku's free tier",
  "Agencies managing client apps across servers",
  "Anyone who's done paying per-seat for infrastructure",
];

const notFor = [
  {
    label: "Kubernetes-scale orchestration",
    aside: "We run Compose, not clusters.",
  },
  {
    label: "Serverless or edge functions",
    aside: "Your containers stay running.",
  },
  {
    label: "Multi-tenant SaaS hosting",
    aside: "This is for your apps, not your customers'.",
  },
  {
    label: "People who want zero ops",
    aside: "That's what Vardo Cloud will be for.",
  },
];

export function Audience() {
  return (
    <Section>
      <div className="grid gap-0 lg:grid-cols-2">
        {/* Built for — welcoming, confident */}
        <div className="rounded-2xl rounded-b-none border border-neutral-800 border-b-0 bg-neutral-900/50 p-10 lg:rounded-r-none lg:rounded-l-2xl lg:border-b lg:border-r-0 sm:p-12">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Built for you... probably
          </h2>
          <div className="mt-10 space-y-6">
            {builtFor.map((item) => (
              <div key={item} className="flex items-start gap-4">
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
                <span className="text-lg leading-snug text-neutral-200">
                  {item}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Not for — honest, a little cheeky */}
        <div className="rounded-2xl rounded-t-none border border-neutral-800 bg-neutral-950 p-10 lg:rounded-l-none lg:rounded-r-2xl lg:rounded-t-2xl lg:border-l-0 sm:p-12">
          <h2 className="text-3xl font-bold tracking-tight text-neutral-500 sm:text-4xl">
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
