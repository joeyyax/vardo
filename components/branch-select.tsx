"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, ChevronDown, Loader2, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type BranchSelectProps = {
  value: string;
  onChange: (value: string) => void;
  /** Provide branches directly (skips API fetch) */
  branches?: string[];
  /** Fetch branches from this project's API */
  projectId?: string;
  orgId?: string;
  /** Branch to exclude from the list (e.g. the production branch) */
  excludeBranch?: string;
  placeholder?: string;
  disabled?: boolean;
};

export function BranchSelect({
  value,
  onChange,
  branches: externalBranches,
  projectId,
  orgId,
  excludeBranch,
  placeholder = "Select a branch...",
  disabled,
}: BranchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [branches, setBranches] = useState<string[]>(externalBranches ?? []);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(!!externalBranches);

  // Sync external branches
  useEffect(() => {
    if (externalBranches) {
      setBranches(externalBranches);
      setFetched(true);
    }
  }, [externalBranches]);

  // Fetch from project API on first open
  const fetchBranches = useCallback(async () => {
    if (fetched || !projectId || !orgId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/branches`
      );
      if (res.ok) {
        const data = await res.json();
        setBranches(data.branches || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [fetched, projectId, orgId]);

  useEffect(() => {
    if (open) fetchBranches();
  }, [open, fetchBranches]);

  const filtered = branches
    .filter((b) => !excludeBranch || b !== excludeBranch)
    .filter((b) => !search || b.toLowerCase().includes(search.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="justify-between font-mono text-sm font-normal h-10 w-full"
        >
          {value ? (
            <span className="flex items-center gap-2 truncate">
              <GitBranch className="size-3.5 shrink-0 opacity-50" />
              {value}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronDown className="ml-2 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <div className="flex items-center border-b px-3">
          <input
            placeholder="Search branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {search ? "No branches match" : "No branches found"}
            </div>
          ) : (
            filtered.map((branch) => (
              <button
                key={branch}
                onClick={() => {
                  onChange(branch);
                  setOpen(false);
                  setSearch("");
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-mono hover:bg-accent cursor-pointer"
              >
                {branch === value ? (
                  <Check className="size-3.5 shrink-0" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{branch}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
