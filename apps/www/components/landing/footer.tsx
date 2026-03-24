import Link from "next/link";

const links = [
  { label: "Documentation", href: "/docs" },
  { label: "GitHub", href: "https://github.com/joeyyax/vardo" },
  { label: "Installation", href: "/docs/installation" },
  { label: "Discussions", href: "https://github.com/joeyyax/vardo/discussions" },
];

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] bg-neutral-950 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 sm:flex-row sm:justify-between sm:px-6 lg:px-8">
        <nav className="flex flex-wrap gap-6" aria-label="Footer navigation">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-sm text-neutral-500 transition-colors duration-150 hover:text-neutral-300"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-sm text-neutral-600">
          Open source &middot; MIT licensed
        </p>
      </div>
    </footer>
  );
}
