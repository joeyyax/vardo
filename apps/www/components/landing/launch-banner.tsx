import Link from "next/link";

export function LaunchBanner() {
  return (
    <div className="border-y border-white/[0.04] py-4">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-3 px-4 text-sm sm:px-6 lg:px-8">
        <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs font-semibold text-neutral-300">
          v1
        </span>
        <span className="text-neutral-500">
          First release is live — building in the open.
        </span>
        <Link
          href="https://github.com/joeyyax/vardo"
          className="text-neutral-400 transition-colors duration-150 hover:text-white"
        >
          Follow along &rarr;
        </Link>
      </div>
    </div>
  );
}
