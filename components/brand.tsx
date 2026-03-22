"use client";

import Link from "next/link";
import { Container } from "lucide-react";

const appName = process.env.NEXT_PUBLIC_APP_NAME || "Vardo";

export function Brand() {
  return (
    <Link href="/" className="brand flex items-center gap-2">
      <Container className="size-5" />
      <span className="font-semibold text-lg tracking-tight">{appName}</span>
    </Link>
  );
}
