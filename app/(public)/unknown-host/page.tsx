import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Service not found",
  description: "The service you are looking for is not available.",
  openGraph: {
    title: "Service not found",
    description: "The service you are looking for is not available.",
  },
};

export default function UnknownHostPage() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-white mb-4">Service not found</h1>
        <p className="text-xl text-slate-300 mb-8">
          The service you are looking for is not available.
        </p>
      </div>
    </div>
  );
}
