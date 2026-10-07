import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Next, Bricolage_Grotesque, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Body face.
const bodySans = Atkinson_Hyperlegible_Next({
  variable: "--font-body-sans",
  subsets: ["latin"],
});

// Display face. Headings only.
const displaySans = Bricolage_Grotesque({
  variable: "--font-display-sans",
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
    <html
      lang="en"
      className={`${bodySans.variable} ${displaySans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem enableColorScheme={false}>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
