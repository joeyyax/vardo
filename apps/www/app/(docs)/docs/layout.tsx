import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import { BrandIcon } from "@/components/brand-icon";

function BrandTitle() {
  return (
    <span className="flex items-center gap-2">
      <BrandIcon />
      Vardo
    </span>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ defaultTheme: "dark" }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{ title: <BrandTitle /> }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
