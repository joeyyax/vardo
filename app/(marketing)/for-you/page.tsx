import type { Metadata } from "next";
import ForYouContent from "./for-you-content";

export const metadata: Metadata = {
  title: "Who It's For",
  description:
    "Built for freelancers, consultants, small studios, and boutique agencies who already know how to work.",
};

export default function ForYouPage() {
  return <ForYouContent />;
}
