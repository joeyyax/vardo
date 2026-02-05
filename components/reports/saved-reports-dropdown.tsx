"use client";

import { useState, useEffect, useCallback } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

type Preset = {
  id: string;
  name: string;
  tab: string;
  filters: Record<string, unknown>;
  createdAt: string;
};

type SavedReportsDropdownProps = {
  orgId: string;
  currentTab: string;
  currentFilters: Record<string, unknown>;
  onApplyPreset: (filters: Record<string, unknown>) => void;
};

function filtersMatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SavedReportsDropdown({
  orgId,
  currentTab,
  currentFilters,
  onApplyPreset,
}: SavedReportsDropdownProps) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [search, setSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [newName, setNewName] = useState("");

  const fetchPresets = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/report-presets`
      );
      if (response.ok) {
        const data = await response.json();
        setPresets(data.presets || data);
      }
    } catch (error) {
      console.error("Error fetching report presets:", error);
    } finally {
      setLoading(false);
      setHasFetched(true);
    }
  }, [orgId]);

  useEffect(() => {
    if (open && !hasFetched) {
      fetchPresets();
    }
  }, [open, hasFetched, fetchPresets]);

  // Reset save input when popover closes
  useEffect(() => {
    if (!open) {
      setIsSaving(false);
      setNewName("");
      setSearch("");
    }
  }, [open]);

  const tabPresets = presets.filter((p) => p.tab === currentTab);

  const filteredPresets = tabPresets.filter((p) => {
    if (!search) return true;
    return p.name.toLowerCase().includes(search.toLowerCase());
  });

  const handleApply = (preset: Preset) => {
    onApplyPreset(preset.filters);
    setOpen(false);
  };

  const handleDelete = async (e: React.MouseEvent, presetId: string) => {
    e.stopPropagation();
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/report-presets/${presetId}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        setPresets((prev) => prev.filter((p) => p.id !== presetId));
        toast.success("Preset deleted");
      }
    } catch (error) {
      console.error("Error deleting preset:", error);
      toast.error("Failed to delete preset");
    }
  };

  const handleSave = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/report-presets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            tab: currentTab,
            filters: currentFilters,
          }),
        }
      );
      if (response.ok) {
        const data = await response.json();
        const newPreset: Preset = data.preset || data;
        setPresets((prev) => [...prev, newPreset]);
        setIsSaving(false);
        setNewName("");
        toast.success("Preset saved");
      }
    } catch (error) {
      console.error("Error saving preset:", error);
      toast.error("Failed to save preset");
    }
  };

  const handleSaveKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") {
      setIsSaving(false);
      setNewName("");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="squircle">
          <Bookmark className="size-4" />
          Saved
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search saved reports..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                Loading...
              </div>
            ) : (
              <>
                {filteredPresets.length > 0 && (
                  <CommandGroup>
                    {filteredPresets.map((preset) => (
                      <CommandItem
                        key={preset.id}
                        value={preset.id}
                        onSelect={() => handleApply(preset)}
                        className="flex items-center justify-between"
                      >
                        <span className="truncate">{preset.name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {filtersMatch(preset.filters, currentFilters) && (
                            <Check className="size-4 text-primary" />
                          )}
                          <button
                            type="button"
                            className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            onClick={(e) => handleDelete(e, preset.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                <CommandSeparator />

                <CommandGroup>
                  {isSaving ? (
                    <div className="flex items-center gap-2 p-2">
                      <Input
                        placeholder="Preset name..."
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={handleSaveKeyDown}
                        className="h-8 text-sm"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        className="h-8 shrink-0 squircle"
                        onClick={handleSave}
                        disabled={!newName.trim()}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <CommandItem onSelect={() => setIsSaving(true)}>
                      <Plus className="size-4" />
                      <span>Save current filters...</span>
                    </CommandItem>
                  )}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
