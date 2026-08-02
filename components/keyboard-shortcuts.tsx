"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

const GO_TIMEOUT_MS = 1000;

const GO_ROUTES: Record<string, string> = {
  p: "/projects",
  m: "/metrics",
  a: "/activity",
  b: "/backups",
};

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "⌘K", description: "Open command palette" },
  { keys: "G P", description: "Go to projects" },
  { keys: "G M", description: "Go to metrics" },
  { keys: "G A", description: "Go to activity" },
  { keys: "G B", description: "Go to backups" },
  { keys: "?", description: "Show this list" },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function isDialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"]');
}

/** `g` then a letter jumps to a section; `?` lists every shortcut. Off while typing or a dialog is open. */
export function KeyboardShortcuts() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const awaitingGoRef = useRef(false);
  const goTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAwaitingGo = useCallback(() => {
    awaitingGoRef.current = false;
    if (goTimeoutRef.current) {
      clearTimeout(goTimeoutRef.current);
      goTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isDialogOpen()) return;

      if (awaitingGoRef.current) {
        clearAwaitingGo();
        const path = GO_ROUTES[e.key.toLowerCase()];
        if (path) {
          e.preventDefault();
          router.push(path);
        }
        return;
      }

      if (e.key === "g") {
        awaitingGoRef.current = true;
        goTimeoutRef.current = setTimeout(clearAwaitingGo, GO_TIMEOUT_MS);
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      clearAwaitingGo();
    };
  }, [router, clearAwaitingGo]);

  return (
    <Sheet open={helpOpen} onOpenChange={setHelpOpen}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>Navigate Vardo without the mouse.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {SHORTCUTS.map((s) => (
            <div
              key={s.keys}
              className="flex items-center justify-between border-b py-2.5 text-sm last:border-0"
            >
              <span className="text-muted-foreground">{s.description}</span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
