"use client";

import Link from "next/dist/client/link";


export function Brand() {

  return (
    <Link href="/" className="brand">
      <span className="font-semibold text-lg tracking-tight">Host</span>
    </Link>
  );
}
