import type { Metadata } from "next";
import InternalWorkContent from "./internal-work-content";

export const metadata: Metadata = {
  title: "Internal Work FAQ",
  description:
    "How Scope handles non-billable work. All work is measured, only some is billed.",
};

export default function InternalWorkFAQPage() {
  return <InternalWorkContent />;
}
