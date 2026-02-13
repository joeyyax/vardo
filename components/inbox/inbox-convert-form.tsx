"use client";

import { useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { InboxItem } from "./types";

const EXPENSE_CATEGORIES = [
  "software",
  "hosting",
  "contractor",
  "travel",
  "supplies",
  "advertising",
  "insurance",
  "subscriptions",
  "office",
  "other",
];

type InboxConvertFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxConvertForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxConvertFormProps) {
  const [description, setDescription] = useState(item.subject || "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState<Date>(new Date(item.receivedAt));
  const [category, setCategory] = useState<string>("none");
  const [projectId, setProjectId] = useState<string | null>(item.projectId);
  const [vendor, setVendor] = useState(item.fromName || "");
  const [isBillable, setIsBillable] = useState(false);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const amountNum = parseFloat(amount);
    if (!description.trim()) {
      toast.error("Description is required");
      return;
    }
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error("Valid amount is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: description.trim(),
            amountCents: Math.round(amountNum * 100),
            date: format(date, "yyyy-MM-dd"),
            category: category === "none" ? null : category,
            projectId,
            isBillable,
            vendor: vendor.trim() || null,
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }

      onConverted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create expense"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Create Expense</h3>

      <div className="grid gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="convert-description">Description</Label>
          <Input
            id="convert-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Expense description"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="convert-amount">Amount</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                $
              </span>
              <Input
                id="convert-amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="pl-7"
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Date</Label>
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !date && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 size-4" />
                  {date ? format(date, "MMM d, yyyy") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={(d) => {
                    if (d) setDate(d);
                    setCalendarOpen(false);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No category</SelectItem>
                {EXPENSE_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="convert-vendor">Vendor</Label>
            <Input
              id="convert-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="Vendor name"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Project</Label>
          <ProjectSelector
            orgId={orgId}
            selectedProjectId={projectId}
            onSelect={setProjectId}
            open={projectSelectorOpen}
            onOpenChange={setProjectSelectorOpen}
          >
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between font-normal"
              type="button"
            >
              {projectId ? "Project selected" : "Overhead (General)"}
              <ChevronDown className="ml-2 size-4 opacity-50" />
            </Button>
          </ProjectSelector>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Create Expense
        </Button>
      </div>
    </form>
  );
}
