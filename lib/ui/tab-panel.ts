import { cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Surface for app detail tab panels whose content doesn't bring its own card. */
export const tabPanelSurface = cn(cardVariants({ variant: "surface" }), "p-4 sm:p-6");
