import { cn } from "@/lib/utils";

type CalloutVariant = "info" | "warning" | "error" | "success";

const variants: Record<CalloutVariant, { border: string; bg: string; label: string; labelColor: string }> = {
  info: { border: "dark:border-status-info/25", bg: "bg-status-info-muted", label: "Info", labelColor: "text-status-info" },
  warning: { border: "dark:border-status-warning/25", bg: "bg-status-warning-muted", label: "Note", labelColor: "text-status-warning" },
  error: { border: "dark:border-status-error/25", bg: "bg-status-error-muted", label: "Warning", labelColor: "text-status-error" },
  success: { border: "dark:border-status-success/25", bg: "bg-status-success-muted", label: "Success", labelColor: "text-status-success" },
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
    <div
      className={cn(
        "squircle flex items-start gap-2.5 rounded-lg px-4 py-3 dark:border",
        v.border,
        v.bg,
        className,
      )}
    >
      <span className={cn("type-body-sm shrink-0 font-semibold", v.labelColor)}>
        {label ?? v.label}
      </span>
      <div className="type-body-sm text-foreground/75">{children}</div>
    </div>
  );
}
