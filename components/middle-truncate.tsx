import type { CSSProperties } from "react";
import { middleSplit } from "@/lib/ui/middle-truncate";
import { cn } from "@/lib/utils";

/** Text that, short of room, loses its middle: "Invoice re…service". Copies and reads as the whole text. */
export function MiddleTruncate({ text, className, style }: { text: string; className?: string; style?: CSSProperties }) {
  const { head, tail } = middleSplit(text);
  if (!tail) return <span className={cn("truncate", className)} style={style}>{text}</span>;
  return (
    <span title={text} className={cn("flex min-w-0", className)} style={style}>
      <span className="min-w-[1ch] overflow-hidden text-ellipsis whitespace-pre">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}
