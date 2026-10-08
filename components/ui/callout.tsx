import { cn } from "@/lib/utils";
import { cardVariants } from "@/components/ui/card";

type CalloutVariant = "info" | "warning" | "error" | "success";

const variants: Record<CalloutVariant, { label: string; labelColor: string }> = {
  info: { label: "Info", labelColor: "text-status-info" },
  warning: { label: "Note", labelColor: "text-status-warning" },
  error: { label: "Warning", labelColor: "text-status-error" },
  success: { label: "Success", labelColor: "text-status-success" },
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
        cardVariants({ variant }),
        "flex items-start gap-2.5 px-4 py-3",
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
