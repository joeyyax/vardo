import type { ReactNode } from "react";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-neutral-950 text-neutral-100">
      {children}
    </div>
  );
}
