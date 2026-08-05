import Link from "next/link";
import { Container, GitBranch, LayoutTemplate } from "lucide-react";

type Card = {
  href: string;
  icon: typeof Container;
  title: string;
  body: string;
};

const TEMPLATE_CARD: Card = {
  href: "/apps/new",
  icon: LayoutTemplate,
  title: "Deploy from a template",
  body: "Postgres, Redis, Grafana and the rest, pre-filled with ports, volumes and variables.",
};

const GIT_CARD: Card = {
  href: "/apps/new?source=github",
  icon: GitBranch,
  title: "Connect a Git repo",
  body: "Build from a Dockerfile, compose file or buildpack, and redeploy on every push.",
};

const IMPORT_CARD: Card = {
  href: "/discover",
  icon: Container,
  title: "Import running containers",
  body: "Adopt the containers already running on this host. Nothing restarts.",
};

/**
 * First thing a new install shows. Each card is an entry to a flow that
 * already exists, so there is no wizard to keep in sync.
 */
export function FirstRun({ canImportContainers }: { canImportContainers: boolean }) {
  const cards = canImportContainers
    ? [IMPORT_CARD, TEMPLATE_CARD, GIT_CARD]
    : [TEMPLATE_CARD, GIT_CARD];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="type-h3">Get your first app running</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">
          A project is a folder for related apps — a database, a web app and a worker that ship
          together. Pick a starting point and Vardo creates the project along the way.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.href}
              href={card.href}
              className="squircle flex flex-col gap-2 rounded-lg bg-card p-5 shadow-card dark:border transition-colors hover:bg-accent/50"
            >
              <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-medium">{card.title}</span>
              <span className="text-sm text-muted-foreground">{card.body}</span>
            </Link>
          );
        })}
      </div>

      <p className="text-sm text-muted-foreground">
        Rather start with an empty project?{" "}
        <Link href="/projects/new" className="underline underline-offset-2 hover:text-foreground">
          Create one
        </Link>
        .
      </p>
    </div>
  );
}
