import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center space-y-3">
        <p className="text-6xl font-mono font-light text-muted-foreground/30">404</p>
        <p className="text-sm text-muted-foreground">That page doesn&apos;t exist.</p>
        <Link
          href="/"
          className="inline-block text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
