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

export default function UnknownHostLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
