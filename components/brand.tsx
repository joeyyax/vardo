"use client";

import Link from "next/link";
import { DEFAULT_APP_NAME } from "@/lib/app-name";

const appName = process.env.NEXT_PUBLIC_APP_NAME || DEFAULT_APP_NAME;

/* Wagon wheel — rim and spokes in ink, hub in brass. */
function Mark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      aria-hidden="true"
      fill="none"
    >
      <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="1.6" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M12 4.5v3.9M12 15.6v3.9M4.5 12h3.9M15.6 12h3.9" />
        <path d="M6.7 6.7l2.75 2.75M14.55 14.55l2.75 2.75M17.3 6.7l-2.75 2.75M9.45 14.55L6.7 17.3" />
      </g>
      <circle
        cx="12"
        cy="12"
        r="2.6"
        fill="var(--background)"
        stroke="var(--brass)"
        strokeWidth="1.6"
      />
    </svg>
  );
}

export function Brand() {
  return (
    <Link href="/" className="brand flex items-center gap-2">
      <Mark />
      <span className="type-h2 tracking-tight">{appName}</span>
    </Link>
  );
}
