import Link from "next/link";
import { Boxes, Container, FileText, GitBranch } from "lucide-react";
import { Github } from "@/components/icons/github";
import { cardVariants } from "@/components/ui/card";
import type { Template } from "@/lib/templates/load";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<string, string> = {
  database: "Databases",
  cache: "Cache & queues",
  monitoring: "Monitoring",
  web: "Web servers",
  tool: "Tools",
  custom: "Custom",
};

export const SOURCE_OPTIONS = [
  { id: "github", icon: Github, label: "GitHub", description: "From your connected account" },
  { id: "public-git", icon: GitBranch, label: "Public Git URL", description: "Any public repo" },
  { id: "compose", icon: FileText, label: "Docker Compose", description: "Paste or from a repo" },
  { id: "image", icon: Container, label: "Image", description: "Any Docker image" },
] as const;

export type SourceOption = (typeof SOURCE_OPTIONS)[number]["id"];

type Props = {
  templatesByCategory: Record<string, Template[]>;
  containerImportEnabled?: boolean;
  onSelectSource: (source: SourceOption) => void;
  onSelectTemplate: (template: Template) => void;
};

export function SourcePicker({ templatesByCategory, containerImportEnabled, onSelectSource, onSelectTemplate }: Props) {
  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="type-h3 text-muted-foreground mb-3">Start from</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {SOURCE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onSelectSource(opt.id)}
                className={cn(cardVariants({ variant: "inset" }), "flex flex-col items-center gap-2 p-4 text-center transition-colors hover:bg-accent/50")}
              >
                <Icon className="size-6 text-muted-foreground" />
                <span className="type-h4">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.description}</span>
              </button>
            );
          })}
          {containerImportEnabled && (
            <Link
              href="/discover"
              className={cn(cardVariants({ variant: "inset" }), "flex flex-col items-center gap-2 p-4 text-center transition-colors hover:bg-accent/50")}
            >
              <Boxes className="size-6 text-muted-foreground" aria-hidden="true" />
              <span className="type-h4">Existing containers</span>
              <span className="text-xs text-muted-foreground">
                Adopt what&apos;s already running on this host
              </span>
            </Link>
          )}
        </div>
      </div>

      {Object.entries(templatesByCategory).map(([category, templates]) => (
        <div key={category}>
          <h2 className="type-h3 text-muted-foreground mb-3">
            {CATEGORY_LABELS[category] || category}
          </h2>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onSelectTemplate(template)}
                className={cn(cardVariants({ variant: "inset" }), "flex items-center gap-3 p-3 text-left transition-colors hover:bg-accent/50")}
              >
                {template.icon ? (
                  <img
                    src={template.icon}
                    alt=""
                    className="size-8 shrink-0"
                    style={{ filter: "drop-shadow(0 0 1px rgba(255,255,255,0.3))" }}
                  />
                ) : (
                  <Container className="size-8 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{template.displayName}</p>
                  {template.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {template.description}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
