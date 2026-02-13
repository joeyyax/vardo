import type { Metadata } from "next";
import PricingContent from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Predictable, fair pricing. No per-seat charges, no feature gating. Free Starter plan, flat Team rate.",
};

export default function PricingPage() {
  return <PricingContent />;
}
