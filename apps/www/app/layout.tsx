import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "Vardo — Self-hosted PaaS",
    template: "%s | Vardo",
  },
  description:
    "Deploy Docker apps with zero DevOps. Self-hosted platform-as-a-service.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
