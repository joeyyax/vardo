import Link from "next/link";

export function LaunchBanner() {
  return (
    <div className="bg-neutral-900/80 py-4">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 text-sm sm:gap-3 sm:px-6 lg:px-8">
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
        <span className="text-neutral-300">
          First release is live — building in the open.
        </span>
        <Link
          href="https://github.com/joeyyax/vardo"
          className="font-medium text-white transition-colors duration-150 hover:text-neutral-300"
        >
          Follow along on GitHub &rarr;
        </Link>
      </div>
    </div>
  );
}
