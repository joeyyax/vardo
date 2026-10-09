"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatEnvVar } from "@/lib/env/dotenv";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Pastes a value that spans lines (a PEM key, a JSON credential) and hands back the env entry for it. */
export function EnvMultilineAdd({ onAdd }: { onAdd: (entry: string) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const valid = KEY_PATTERN.test(key) && value !== "";

  function add() {
    if (!valid) return;
    onAdd(formatEnvVar(key, value));
    setKey("");
    setValue("");
    setOpen(false);
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 size-4" />
        Multi-line value
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="env-multiline-add">
      <Input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="GOOGLE_PRIVATE_KEY"
        aria-label="Variable name"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
      />
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste the value, line breaks included"
        aria-label="Value"
        rows={6}
        className="font-mono text-xs"
        spellCheck={false}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={add} disabled={!valid}>
          Add
        </Button>
      </div>
    </div>
  );
}
