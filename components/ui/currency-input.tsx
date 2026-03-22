import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type CurrencyInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type"
> & {
  symbol?: string;
};

const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ symbol = "$", className, ...props }, ref) => {
    return (
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {symbol}
        </span>
        <Input
          ref={ref}
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          className={cn("squircle pl-7", className)}
          {...props}
        />
      </div>
    );
  }
);
CurrencyInput.displayName = "CurrencyInput";

export { CurrencyInput };
