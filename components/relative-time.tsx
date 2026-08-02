"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsoluteDateTime, formatRelativeTime, toDate, type DateInput } from "@/lib/ui/relative-time";

type RelativeTimeProps = {
  date: DateInput;
  className?: string;
  /** Show the absolute date as the visible text, with relative time on hover. */
  absoluteFirst?: boolean;
};

const TICK_MS = 30_000;

/** A `<time>` element: relative text by default, exact date and time on hover. */
export function RelativeTime({ date, className, absoluteFirst = false }: RelativeTimeProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const parsed = toDate(date);
  if (!parsed) {
    return <span className={className}>—</span>;
  }

  const relative = formatRelativeTime(parsed);
  const absolute = formatAbsoluteDateTime(parsed);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={parsed.toISOString()} className={className}>
          {absoluteFirst ? absolute : relative}
        </time>
      </TooltipTrigger>
      <TooltipContent>{absoluteFirst ? relative : absolute}</TooltipContent>
    </Tooltip>
  );
}
