"use client";

import Link from "next/link";
import { Container } from "lucide-react";
import { DEFAULT_APP_NAME } from "@/lib/app-name";

const appName = process.env.NEXT_PUBLIC_APP_NAME || DEFAULT_APP_NAME;

export function Brand() {
  return (
    <Link href="/" className="brand flex items-center gap-2">
      <Container className="size-5" />
      <span className="font-semibold text-lg tracking-tight">{appName}</span>
    </Link>
  );
}
