import { Brand } from "@/components/brand";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <header className="flex items-center px-6 py-4">
        <Brand />
      </header>
      <main>{children}</main>
    </div>
  );
}
