import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
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

import { DEFAULT_APP_NAME } from "@/lib/app-name";

const appName = process.env.NEXT_PUBLIC_APP_NAME || DEFAULT_APP_NAME;

export const metadata: Metadata = {
  title: {
    default: appName,
    template: `%s — ${appName}`,
  },
  description: "Self-hosted PaaS for managing Docker Compose deployments.",
  openGraph: {
    type: "website",
    title: appName,
    description: "Self-hosted PaaS for managing Docker Compose deployments.",
  },
  twitter: {
    card: "summary",
    title: appName,
    description: "Self-hosted PaaS for managing Docker Compose deployments.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
        <PlausibleTracker />
      </body>
    </html>
  );
}
