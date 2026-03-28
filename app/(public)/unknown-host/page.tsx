import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Service not found",
  description: "The service you are looking for is not available.",
  robots: { index: false },
  openGraph: {
    title: "Service not found",
    description: "The service you are looking for is not available.",
  },
};

export default function UnknownHostPage() {
  return (
    <div className="flex items-center justify-center min-h-dvh bg-background">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-foreground mb-4">
          Service not found
        </h1>
        <p className="text-xl text-muted-foreground mb-8">
          The service you are looking for is not available.
        </p>
        <Link href="/" className="text-sm text-muted-foreground underline">
          Go home
        </Link>
      </div>
    </div>
  );
}
