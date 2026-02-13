import type { Metadata } from "next";
import ChoosingContent from "./choosing-content";

export const metadata: Metadata = {
  title: "Choosing the Right Tool",
  description:
    "Scope is intentionally opinionated. See how it compares and whether it's the right fit for your work.",
};

export default function ChoosingTheRightToolPage() {
  return <ChoosingContent />;
}
