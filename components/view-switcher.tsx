"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { VIEW_CONFIGS, type ViewType } from "@/lib/views";

type ViewSwitcherProps<T extends ViewType> = {
  views: readonly T[];
  value: T;
  onValueChange: (view: T) => void;
};

export function ViewSwitcher<T extends ViewType>({
  views,
  value,
  onValueChange,
}: ViewSwitcherProps<T>) {
  if (views.length <= 1) return null;

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      size="sm"
    >
      {views.map((view) => {
        const config = VIEW_CONFIGS[view];
        const Icon = config.icon;
        return (
          <ToggleGroupItem key={view} value={view} title={config.label}>
            <Icon className="size-4" />
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
