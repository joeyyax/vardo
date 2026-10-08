import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// `default` is the padded, stacked card. `surface` is the same skin with layout left to the caller.
// `inset` is a recessed tray. Tones are status panels.
const cardVariants = cva("squircle rounded-lg", {
  variants: {
    variant: {
      // Dark keeps a hairline; shadows barely read on a dark ground.
      default: "bg-card text-card-foreground @container flex flex-col gap-5 py-6 shadow-card dark:border",
      surface: "bg-card text-card-foreground @container shadow-card dark:border",
      inset: "bg-background-deep",
      info: "border border-status-info-edge bg-status-info-muted",
      success: "border border-status-success-edge bg-status-success-muted",
      warning: "border border-status-warning-edge bg-status-warning-muted",
      error: "border border-status-error-edge bg-status-error-muted",
    },
  },
  defaultVariants: { variant: "default" },
})

function Card({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant }), className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 @lg:px-7 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4",
        className
      )}
      {...props}
    />
  )
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6"

// Heading level comes from the call site; the look stays type-h3.
function CardTitle({
  as: Tag = "h3",
  className,
  ...props
}: React.ComponentProps<"h3"> & { as?: HeadingTag }) {
  return (
    <Tag
      data-slot="card-title"
      className={cn("type-h3", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6 @lg:px-7", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 @lg:px-7 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  cardVariants,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
