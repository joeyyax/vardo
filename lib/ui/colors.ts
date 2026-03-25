export const PALETTE = [
  { name: "Slate", hex: "#64748b" },
  { name: "Red", hex: "#ef4444" },
  { name: "Orange", hex: "#f97316" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Green", hex: "#22c55e" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Purple", hex: "#a855f7" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Cyan", hex: "#06b6d4" },
] as const;

export type PaletteColor = (typeof PALETTE)[number];

export function randomPaletteColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)].hex;
}
