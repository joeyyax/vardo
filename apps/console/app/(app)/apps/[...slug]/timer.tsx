"use client";

import { useState, useEffect } from "react";

function formatUptime(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function Timer({ since, className }: { since: number; className?: string }) {
  const [elapsed, setElapsed] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const ms = Date.now() - since;
      const s = Math.floor(ms / 1000);
      if (s < 60) setElapsed(`${s}s`);
      else setElapsed(`${Math.floor(s / 60)}m ${s % 60}s`);
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
    const update = () => setText(formatUptime(since));
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
