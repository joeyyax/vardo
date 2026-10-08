"use client";

import { useState, useEffect } from "react";
import { formatUptime } from "@/lib/metrics/format";

export function Timer({ since, className }: { since: number; className?: string }) {
  const [elapsed, setElapsed] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      setElapsed(formatUptime((Date.now() - since) / 1000));
    };
    const interval = setInterval(tick, 1000);
    const id = requestAnimationFrame(tick);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(id);
    };
  }, [since]);
  if (!elapsed) return null;
  return <span className={`tabular-nums ${className || ""}`}>{elapsed}</span>;
}

export function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setText(formatUptime((Date.now() - new Date(since).getTime()) / 1000));
    const interval = setInterval(update, 1000);
    const id = requestAnimationFrame(update);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(id);
    };
  }, [since]);
  if (!text) return null;
  return (
    <span className="ml-1.5 text-status-success/70 text-xs font-normal tabular-nums">
      {text}
    </span>
  );
}
