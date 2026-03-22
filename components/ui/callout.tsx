import { cn } from "@/lib/utils";

type CalloutVariant = "info" | "warning" | "error" | "success";

const variants: Record<CalloutVariant, { border: string; bg: string; label: string; labelColor: string }> = {
  info: { border: "border-blue-500/20", bg: "bg-blue-500/5", label: "Info", labelColor: "text-blue-500" },
  warning: { border: "border-amber-500/20", bg: "bg-amber-500/5", label: "Note", labelColor: "text-amber-500" },
  error: { border: "border-red-500/20", bg: "bg-red-500/5", label: "Warning", labelColor: "text-red-500" },
  success: { border: "border-green-500/20", bg: "bg-green-500/5", label: "Success", labelColor: "text-green-500" },
};

type CalloutProps = {
  variant?: CalloutVariant;
  label?: string;
  children: React.ReactNode;
  className?: string;
};

export function Callout({ variant = "info", label, children, className }: CalloutProps) {
  const v = variants[variant];
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-2", v.border, v.bg, className)}>
      <span className={cn("text-xs font-medium shrink-0", v.labelColor)}>
        {label ?? v.label}
      </span>
      <div className="text-xs text-muted-foreground">{children}</div>
    </div>
  );
}
