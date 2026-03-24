import Link from "next/link";

const links = [
  { label: "Documentation", href: "/docs" },
  { label: "GitHub", href: "https://github.com/joeyyax/vardo" },
  { label: "Installation", href: "/docs/installation" },
  { label: "Discussions", href: "https://github.com/joeyyax/vardo/discussions" },
];

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] bg-neutral-950 py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center">
          <p className="text-sm text-neutral-400">
            Fresh out of the oven — first release, building fast.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="https://github.com/joeyyax/vardo"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors duration-150 hover:border-neutral-700 hover:text-neutral-200"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Star on GitHub
            </Link>
            <Link
              href="https://github.com/joeyyax/vardo/issues"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors duration-150 hover:border-neutral-700 hover:text-neutral-200"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Feedback
            </Link>
            <span className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-500">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              MIT
            </span>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center gap-4 border-t border-white/[0.04] pt-8 sm:flex-row sm:justify-between">
          <nav className="flex flex-wrap gap-6" aria-label="Footer navigation">
            {links.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-sm text-neutral-600 transition-colors duration-150 hover:text-neutral-300"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <p className="text-sm text-neutral-700">
            Open source &middot; MIT licensed
          </p>
        </div>
      </div>
    </footer>
  );
}
