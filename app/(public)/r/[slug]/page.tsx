import { notFound } from "next/navigation";
import { PublicReportContent } from "./report-content";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
};

export default async function PublicReportPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { from, to } = await searchParams;

  // Fetch report data server-side for initial render
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const queryParams = new URLSearchParams();
  if (from) queryParams.set("from", from);
  if (to) queryParams.set("to", to);

  const response = await fetch(
    `${baseUrl}/api/reports/${slug}${queryParams.toString() ? `?${queryParams}` : ""}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    if (response.status === 404 || response.status === 403) {
      notFound();
    }
    throw new Error("Failed to fetch report");
  }

  const data = await response.json();

  return <PublicReportContent slug={slug} initialData={data} />;
}
