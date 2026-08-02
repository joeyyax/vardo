/** cmdk keys items by lowercased value, so two apps named Gitea and gitea collide. */
export const ID_SEP = "\u241f";

/**
 * Name matches beat keyword matches, and nothing matches loosely. cmdk's default
 * is fuzzy, which ranked plextraktsync above plex for "plex" and returned Kroki
 * for "loki" — on a fleet this size the noise costs more than the typo tolerance.
 */
export function rankResult(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;

  const name = value.split(ID_SEP)[0].toLowerCase();
  if (name === q) return 1;
  if (name.startsWith(q)) return 0.9;
  if (name.includes(q)) return 0.7;

  const kw = (keywords ?? []).map((k) => k.toLowerCase());
  if (kw.some((k) => k === q)) return 0.5;
  if (kw.some((k) => k.startsWith(q))) return 0.4;
  if (kw.some((k) => k.includes(q))) return 0.3;

  return 0;
}

/** cmdk hides non-matches but keeps source order, so relevance is sorted here. */
export function byRelevance<T>(
  items: T[],
  search: string,
  fields: (item: T) => [string, string[]],
) {
  if (!search.trim()) return items;
  return [...items].sort((a, b) => {
    const [an, ak] = fields(a);
    const [bn, bk] = fields(b);
    return rankResult(bn, search, bk) - rankResult(an, search, ak);
  });
}

export type CommandActionId = "restart" | "deploy" | "logs" | "rollback";

export type CommandActionDef = {
  id: CommandActionId;
  /** Matched first, and the label before an app is chosen. */
  verb: string;
  keywords: string[];
  /** Placeholder while the second step picks the app. */
  prompt: string;
  /** Null for actions that only navigate. `{app}` is filled with the app name. */
  confirm: {
    title: string;
    description: string;
    label: string;
    loadingLabel: string;
    variant: "destructive" | "default";
  } | null;
};

export const COMMAND_ACTIONS: CommandActionDef[] = [
  {
    id: "restart",
    verb: "Restart",
    keywords: ["restart", "reboot", "bounce", "cycle", "reload"],
    prompt: "Restart which app?",
    confirm: {
      title: "Restart {app}?",
      description: "Containers stop and start again. Requests fail until they are back up.",
      label: "Restart",
      loadingLabel: "Restarting...",
      variant: "destructive",
    },
  },
  {
    id: "deploy",
    verb: "Deploy",
    keywords: ["deploy", "redeploy", "release", "ship", "build"],
    prompt: "Deploy which app?",
    confirm: {
      title: "Deploy {app}?",
      description:
        "Builds and swaps in a new release from the current source. A failed deploy rolls back on its own.",
      label: "Deploy",
      loadingLabel: "Deploying...",
      variant: "default",
    },
  },
  {
    id: "logs",
    verb: "Logs for",
    keywords: ["logs", "log", "tail", "output", "stdout"],
    prompt: "Logs for which app?",
    confirm: null,
  },
  {
    id: "rollback",
    verb: "Roll back",
    keywords: ["rollback", "roll back", "revert", "undo", "previous"],
    prompt: "Roll back which app?",
    confirm: {
      title: "Roll back {app}?",
      description:
        "Swaps traffic to the previous release still running alongside this one. The current release keeps running until it is replaced.",
      label: "Roll back",
      loadingLabel: "Rolling back...",
      variant: "destructive",
    },
  },
];

/** Actions the query matches, best first. Never matches loosely. */
export function rankActions(search: string): CommandActionDef[] {
  return COMMAND_ACTIONS.map((action) => ({
    action,
    score: rankResult(action.verb, search, action.keywords),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.action);
}

export function fillApp(text: string, appName: string): string {
  return text.replace(/\{app\}/g, appName);
}
