import type { Metadata } from "next";
import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { Audience } from "@/components/landing/audience";
import { SocialProof } from "@/components/landing/social-proof";
import { InstallCta } from "@/components/landing/install-cta";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
  title: "Vardo — Self-hosted PaaS for Docker",
  description:
    "Deploy Docker apps on your own server with automatic TLS, blue-green deployments, backups, and monitoring. No DevOps required.",
};

export default function HomePage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Features />
        <Audience />
        <SocialProof />
        <InstallCta />
      </main>
      <Footer />
    </>
  );
}
