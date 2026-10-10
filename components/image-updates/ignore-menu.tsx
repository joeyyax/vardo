"use client";

import { BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IGNORE_DURATIONS, type IgnoreScope } from "@/lib/docker/image-updates/ignore";

export type IgnoreChoice = { scope: IgnoreScope; days: number | null };

/** Silences one service, not the stack. Majors are held by the track policy instead. */
export function IgnoreMenu({
  label,
  disabled,
  onChoose,
}: {
  /** Names the target for a screen reader, e.g. "redis on GlitchTip". */
  label: string;
  disabled?: boolean;
  onChoose: (choice: IgnoreChoice) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          aria-label={`Ignore updates for ${label}`}
          className="text-muted-foreground/50 hover:text-foreground"
        >
          <BellOff aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup aria-label="Ignore updates">
          <DropdownMenuLabel className="type-label text-muted-foreground/60">
            Ignore updates
          </DropdownMenuLabel>
          {IGNORE_DURATIONS.map((duration) => (
            <DropdownMenuItem
              key={duration.label}
              aria-label={`Ignore updates for ${duration.label}`}
              onSelect={() => onChoose({ scope: "all", days: duration.days })}
            >
              {duration.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
