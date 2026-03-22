"use client";

import Link from "next/dist/client/link";


export function Brand() {

  return (
    <Link href="/" className="brand flex items-center gap-1">
      <span className="font-bold text-lg text-neutral-800/70">[</span>
      <span className="font-bold text-lg">host</span>
      <span className="font-bold text-lg text-neutral-800/70">]</span>
    </Link>
  );
}
