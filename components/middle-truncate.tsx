"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { middleMinWidth, middleSplit } from "@/lib/ui/middle-truncate";
import { cn } from "@/lib/utils";

/** The narrowest a name's cell gets: an ellipsis and its tail as rendered, estimated until measured. */
export function useMiddleMin(text: string) {
  const tailRef = useRef<HTMLSpanElement>(null);
  const [tailPx, setTailPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = tailRef.current;
    if (!el) return setTailPx(null);
    const measure = () => setTailPx(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return { tailRef, minWidth: tailPx === null ? middleMinWidth(text) : `calc(${tailPx}px + 1ch)` };
}

/** Text that, short of room, loses its middle: "Invoice re…service". Copies and reads as the whole text. */
export function MiddleTruncate({
  text,
  className,
  style,
  tailRef,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
  /** From `useMiddleMin`, so the cell holding the name keeps room for the tail. */
  tailRef?: Ref<HTMLSpanElement>;
}) {
  const { head, tail } = middleSplit(text);
  if (!tail) return <span className={cn("truncate", className)} style={style}>{text}</span>;
  return (
    <span title={text} className={cn("flex min-w-0", className)} style={style}>
      <span className="min-w-[1ch] overflow-hidden text-ellipsis whitespace-pre">{head}</span>
      <span ref={tailRef} className="shrink-0 whitespace-pre">
        {tail}
      </span>
    </span>
  );
}
