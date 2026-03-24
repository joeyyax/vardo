import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-950">
      <div className="text-center space-y-3">
        <p className="text-6xl font-mono font-light text-neutral-800">404</p>
        <p className="text-sm text-neutral-500">That page doesn&apos;t exist.</p>
        <Link
          href="/"
          className="inline-block text-sm text-neutral-400 hover:text-white transition-colors underline underline-offset-4"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
