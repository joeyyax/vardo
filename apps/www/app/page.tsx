import type { Metadata } from "next";
import { Hero } from "../components/landing/hero";
import { Features } from "../components/landing/features";
import { HowItWorks } from "../components/landing/how-it-works";
import { WhyVardo } from "../components/landing/why-vardo";
import { InstallCta } from "../components/landing/install-cta";
import { Footer } from "../components/landing/footer";

export const metadata: Metadata = {
  title: "Vardo — Self-hosted PaaS for Docker",
  description:
    "Deploy Docker apps on your own server with automatic TLS, blue-green deployments, backups, and monitoring. No DevOps required.",
};

export default function HomePage() {
  return (
    <main>
      <Hero />
      <Features />
      <HowItWorks />
      <WhyVardo />
      <InstallCta />
      <Footer />
    </main>
  );
}
