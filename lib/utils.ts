import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge ships its own idea of the font-size scale and doesn't read our
// Tailwind theme, so it doesn't know `--text-2xs`/`--text-15` are font sizes. Left
// unregistered, it misclassifies `text-2xs`/`text-15` as text-COLOR utilities — so a
// single cn() carrying both a custom size and a real color drops the color (the `lg`
// button size's `text-15` was silently eating `text-primary-foreground`, leaving primary
// CTAs with the wrong foreground). Registering them as font sizes keeps both.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["2xs", "15"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
