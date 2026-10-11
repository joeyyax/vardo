"use client";

import { ArrowDownUp } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProjectSort } from "@/lib/db/schema/enums";
import { isProjectSort, SORT_LABEL } from "@/lib/ui/projects";

export function SortSelect({ value, onChange, label }: { value: ProjectSort; onChange: (sort: ProjectSort) => void; label: string }) {
  return (
    <Select value={value} onValueChange={(v) => isProjectSort(v) && onChange(v)}>
      <SelectTrigger aria-label={label} className="w-auto gap-1.5">
        <ArrowDownUp aria-hidden="true" className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {(Object.keys(SORT_LABEL) as ProjectSort[]).map((key) => (
          <SelectItem key={key} value={key}>
            {SORT_LABEL[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
