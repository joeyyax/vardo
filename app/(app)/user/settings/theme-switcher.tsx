"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Auto", icon: Monitor },
] as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return (
    <Card className="squircle rounded-lg">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Choose how Vardo looks for you.</CardDescription>
      </CardHeader>
      <CardContent>
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors",
              mounted && theme === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
      </CardContent>
    </Card>
  );
}
