import Link from "next/link";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Installation", href: "/docs/installation" },
      { label: "Features", href: "/docs/concepts" },
      { label: "API Reference", href: "/docs/api-reference" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "CLI Reference", href: "/docs/cli-reference" },
      { label: "Configuration", href: "/docs/configuration" },
      { label: "Security", href: "/docs/security" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: "https://github.com/joeyyax/vardo" },
      { label: "Discussions", href: "https://github.com/joeyyax/vardo/discussions" },
      { label: "Issues", href: "https://github.com/joeyyax/vardo/issues" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] bg-neutral-950">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div>
            <Link href="/" className="flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-neutral-100"
              >
                <path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z" />
                <path d="M10 21.9V14L2.1 9.1" />
                <path d="m10 14 11.9-6.9" />
                <path d="M14 19.8v-8.1" />
                <path d="M18 17.5V9.4" />
              </svg>
              <span className="text-lg font-semibold tracking-tight text-neutral-100">
                Vardo
              </span>
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-neutral-500">
              Self-hosted platform for deploying Docker apps. Your server, your
              rules.
            </p>
          </div>

          {/* Link columns */}
          {columns.map((col) => (
            <div key={col.title}>
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500">
                {col.title}
              </p>
              <ul className="mt-4 space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-neutral-500 transition-colors duration-150 hover:text-neutral-200"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 border-t border-white/[0.04] pt-8 text-center text-sm text-neutral-700">
          Open source &middot; MIT licensed
        </div>
      </div>
    </footer>
  );
}
