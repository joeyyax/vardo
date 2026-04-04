"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

type Column = {
  key: string;
  label: string;
};

type DataTableProps = {
  title: string;
  columns?: Column[];
  dataSource: string;
  emptyMessage?: string;
};

type FetchState = "idle" | "loading" | "success" | "error";

export function DataTable({
  title,
  columns: columnsProp,
  dataSource,
  emptyMessage = "No data available.",
}: DataTableProps) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<Column[]>(columnsProp ?? []);
  const [state, setState] = useState<FetchState>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const fetchData = useCallback(async () => {
    setState("loading");
    setErrorMessage("");

    try {
      const res = await fetch(dataSource);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      const json = await res.json();
      const data: Record<string, unknown>[] = Array.isArray(json)
        ? json
        : json.data ?? json.rows ?? json.items ?? [];

      setRows(data);

      // If no columns were declared, infer from the first row
      if (!columnsProp?.length && data.length > 0) {
        const keys = Object.keys(data[0]).filter(
          (k) => !k.startsWith("_") && k !== "id",
        );
        setColumns(
          keys.map((k) => ({
            key: k,
            label: k
              .replace(/([A-Z])/g, " $1")
              .replace(/[_-]/g, " ")
              .replace(/^\w/, (c) => c.toUpperCase())
              .trim(),
          })),
        );
      }

      setState("success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load data");
      setState("error");
    }
  }, [dataSource, columnsProp]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="squircle border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={fetchData}
          disabled={state === "loading"}
          aria-label={`Refresh ${title}`}
        >
          <RefreshCw
            className={`size-3.5 ${state === "loading" ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {state === "loading" && rows.length === 0 && (
        <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
          Loading...
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <span>{errorMessage}</span>
          <Button variant="outline" size="xs" onClick={fetchData}>
            Retry
          </Button>
        </div>
      )}

      {state === "success" && rows.length === 0 && (
        <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      )}

      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.key}>{col.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={(row.id as string) ?? i}>
                {columns.map((col) => (
                  <TableCell key={col.key}>
                    {formatCellValue(row[col.key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
