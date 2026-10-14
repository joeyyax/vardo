import { middleSplit } from "@/lib/ui/middle-truncate";
import { cn } from "@/lib/utils";

/** Text that, short of room, loses its middle: "Invoice re…service". Copies and reads as the whole text. */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const { head, tail } = middleSplit(text);
  if (!tail) return <span className={cn("truncate", className)}>{text}</span>;
  return (
    <span title={text} className={cn("flex min-w-0", className)}>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}
