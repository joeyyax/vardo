import { cn } from "@/lib/utils";

export function Section({
  children,
  className,
  size = "default",
  width = "default",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "default" | "small" | "large";
  width?: "default" | "wide";
}) {
  const padding = {
    default: "py-16 sm:py-20",
    small: "py-10 sm:py-14",
    large: "py-20 sm:py-28",
  };
  const maxWidth = width === "wide" ? "max-w-5xl" : "max-w-3xl";
  return (
    <section className={cn(padding[size], "px-4", className)}>
      <div className={cn(maxWidth, "mx-auto")}>{children}</div>
    </section>
  );
}
