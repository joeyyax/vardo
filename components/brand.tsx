"use client";

import Link from "next/dist/client/link";
import { Container } from "lucide-react";


export function Brand() {

  return (
    <Link href="/" className="brand flex items-center gap-2">
      <Container className="size-5" />
      <span className="font-semibold text-lg tracking-tight">Vardo</span>
    </Link>
  );
}
