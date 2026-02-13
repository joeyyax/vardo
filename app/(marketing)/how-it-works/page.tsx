import type { Metadata } from "next";
import HowItWorksContent from "./how-it-works-content";

export const metadata: Metadata = {
  title: "How It Works",
  description:
    "See how Scope connects proposals, tasks, time tracking, and billing into one clear system for client work.",
};

export default function HowItWorksPage() {
  return <HowItWorksContent />;
}
