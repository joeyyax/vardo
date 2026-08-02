"use client";

import { BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IGNORE_DURATIONS, type IgnoreScope } from "@/lib/docker/image-updates/ignore";

export type IgnoreChoice = { scope: IgnoreScope; days: number | null };

/**
 * Silences one service, not the stack. Major-only is its own branch because it
 * is the common case: keep the patches, hold the postgres 16 → 18.
 */
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
        {/* Grouped, not just headed: the two branches offer the same three
            spans, and unlabeled groups read as six identical items. */}
        <DropdownMenuGroup aria-label="Ignore majors only">
          <DropdownMenuLabel className="type-label text-muted-foreground/60">
            Ignore majors only
          </DropdownMenuLabel>
          {IGNORE_DURATIONS.map((duration) => (
            <DropdownMenuItem
              key={`major-${duration.label}`}
              aria-label={`Ignore majors for ${duration.label}`}
              onSelect={() => onChoose({ scope: "major", days: duration.days })}
            >
              {duration.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup aria-label="Ignore all updates">
          <DropdownMenuLabel className="type-label text-muted-foreground/60">
            Ignore all updates
          </DropdownMenuLabel>
          {IGNORE_DURATIONS.map((duration) => (
            <DropdownMenuItem
              key={`all-${duration.label}`}
              aria-label={`Ignore all updates for ${duration.label}`}
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
