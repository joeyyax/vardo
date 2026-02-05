import { Calendar, Table2, LayoutGrid, Kanban, LayoutList } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ViewType = "timeline" | "table" | "card" | "board" | "list";

export type ViewConfig = {
  value: ViewType;
  label: string;
  icon: LucideIcon;
};

export const VIEW_CONFIGS: Record<ViewType, ViewConfig> = {
  timeline: { value: "timeline", label: "Timeline", icon: Calendar },
  table: { value: "table", label: "Table", icon: Table2 },
  card: { value: "card", label: "Card", icon: LayoutGrid },
  board: { value: "board", label: "Board", icon: Kanban },
  list: { value: "list", label: "List", icon: LayoutList },
};
