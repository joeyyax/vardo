import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="max-w-2xl text-center">
        <h1 className="text-5xl font-bold tracking-tight">Vardo</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Deploy Docker apps with zero DevOps. Self-hosted
          platform-as-a-service.
        </p>
        <div className="mt-8 flex gap-4 justify-center">
          <Link
            href="/docs"
            className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Documentation
          </Link>
          <Link
            href="https://github.com/joeyyax/vardo"
            className="rounded-lg border px-6 py-3 text-sm font-medium hover:bg-accent"
          >
            GitHub
          </Link>
        </div>
      </div>
    </main>
  );
}
