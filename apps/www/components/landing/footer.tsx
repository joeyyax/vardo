import Link from "next/link";
import { BrandIcon } from "../brand-icon";

const columns = [
  {
    title: "Documentation",
    links: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Installation", href: "/docs/installation" },
      { label: "Concepts", href: "/docs/concepts" },
      { label: "API Reference", href: "/docs/api-reference" },
      { label: "CLI Reference", href: "/docs/cli-reference" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: "https://github.com/joeyyax/vardo" },
      { label: "Discussions", href: "https://github.com/joeyyax/vardo/discussions" },
      { label: "Issues", href: "https://github.com/joeyyax/vardo/issues" },
      { label: "Contributing", href: "/docs/contributing" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] bg-neutral-950">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {/* Brand */}
          <div>
            <Link href="/" className="flex items-center gap-2">
              <BrandIcon className="text-neutral-100" />
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
