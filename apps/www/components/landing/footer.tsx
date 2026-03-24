import Link from "next/link";

const links = [
  { label: "Documentation", href: "/docs" },
  { label: "GitHub", href: "https://github.com/joeyyax/vardo" },
  { label: "Installation", href: "/docs/installation" },
  { label: "Discussions", href: "https://github.com/joeyyax/vardo/discussions" },
];

export function Footer() {
  return (
    <footer className="border-t border-border py-8">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 sm:flex-row sm:justify-between sm:px-6 lg:px-8">
        <nav className="flex flex-wrap gap-6" aria-label="Footer navigation">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-sm text-muted-foreground">
          Open source &middot; MIT licensed
        </p>
      </div>
    </footer>
  );
}
