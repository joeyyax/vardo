"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

type ExportDropdownProps = {
  orgId: string;
  tab: string;
  params: Record<string, string | null | undefined>;
};

export function ExportDropdown({ orgId, tab, params }: ExportDropdownProps) {
  function buildUrl(format: "csv" | "pdf") {
    const searchParams = new URLSearchParams();
    searchParams.set("format", format);
    searchParams.set("tab", tab);
    for (const [key, value] of Object.entries(params)) {
      if (value) searchParams.set(key, value);
    }
    return `/api/v1/organizations/${orgId}/reports/export?${searchParams.toString()}`;
  }

  function handleExport(format: "csv" | "pdf") {
    window.open(buildUrl(format), "_blank");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="squircle">
          <Download className="size-4" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="squircle">
        <DropdownMenuItem onClick={() => handleExport("csv")}>
          Download CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("pdf")}>
          Download PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
