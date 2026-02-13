import type { Metadata } from "next";
import WhyContent from "./why-content";

export const metadata: Metadata = {
  title: "Why This Exists",
  description:
    "Client work shouldn't feel harder than the work itself. Scope replaces fragmented tools with one intentional system.",
};

export default function WhyPage() {
  return <WhyContent />;
}
