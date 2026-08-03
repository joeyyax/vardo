import { cn } from "@/lib/utils";

type CalloutVariant = "info" | "warning" | "error" | "success";

const variants: Record<CalloutVariant, { border: string; bg: string; label: string; labelColor: string }> = {
  info: { border: "border-status-info/20", bg: "bg-status-info-muted", label: "Info", labelColor: "text-status-info" },
  warning: { border: "border-status-warning/20", bg: "bg-status-warning-muted", label: "Note", labelColor: "text-status-warning" },
  error: { border: "border-status-error/20", bg: "bg-status-error-muted", label: "Warning", labelColor: "text-status-error" },
  success: { border: "border-status-success/20", bg: "bg-status-success-muted", label: "Success", labelColor: "text-status-success" },
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
