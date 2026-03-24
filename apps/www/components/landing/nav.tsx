"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 16);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-200 ${
        scrolled
          ? "border-b border-border bg-background/80 backdrop-blur-lg"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="text-xl font-bold tracking-wide text-foreground uppercase"
          style={{ letterSpacing: "0.12em" }}
        >
          Vardo
        </Link>
        <nav className="flex items-center gap-6" aria-label="Main navigation">
          <Link
            href="/docs"
            className="hidden text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground sm:inline-block"
          >
            Docs
          </Link>
          <Link
            href="https://github.com/joeyyax/vardo"
            className="hidden text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground sm:inline-block"
          >
            GitHub
          </Link>
          <Link
            href="/docs/getting-started"
            className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
          >
            Get Started
          </Link>
        </nav>
      </div>
    </header>
  );
}
