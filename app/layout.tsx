import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { PlausibleTracker } from "@/components/plausible";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Scope — Run client work without chaos",
    template: "%s — Scope",
  },
  description:
    "A calm, opinionated system for running client work. Proposals, tasks, time, and billing — connected by default.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Toaster position="bottom-right" />
        <PlausibleTracker />
        <script
          src="/widget/scope.js"
          data-key="sc_ecZV91FK0a1gV9VD6j9R_Gm2"
          defer
        />
      </body>
    </html>
  );
}
