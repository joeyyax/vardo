// The question the app owner is asked about rules that ship off.

import { PROBE_RULES } from "./rules";
import type { AppProbeGuard } from "./settings";

const WORDPRESS_IMAGE = /(?:^|\/)wordpress(?:[:@]|$)/i;
const WORDPRESS_COMPOSE = /^\s*image:\s*["']?(?:\S+\/)?wordpress(?:[:@"'\s]|$)/im;

/** Whether an app looks like WordPress from its image, template or compose file. It only decides whether to ask. */
export function detectWordPress(app: {
  imageName?: string | null;
  templateName?: string | null;
  composeContent?: string | null;
  childImages?: readonly (string | null)[];
}): boolean {
  if (app.templateName?.toLowerCase().includes("wordpress")) return true;
  const images = [app.imageName, ...(app.childImages ?? [])].filter((i): i is string => !!i);
  if (images.some((i) => WORDPRESS_IMAGE.test(i))) return true;
  return !!app.composeContent && WORDPRESS_COMPOSE.test(app.composeContent);
}

export type ProbeSuggestion = {
  id: "wordpress-probes";
  /** The rules the answer switches. */
  ruleIds: string[];
  title: string;
  description: string;
};

const WORDPRESS_RULE_IDS = PROBE_RULES.filter((r) => r.category === "wordpress" || r.id === "wp-config").map((r) => r.id);

/** The question to ask, or null. Asked only for an app that doesn't look like WordPress and hasn't answered. */
export function pendingSuggestion(guard: AppProbeGuard, looksLikeWordPress: boolean): ProbeSuggestion | null {
  if (!guard.enabled || looksLikeWordPress) return null;
  if (WORDPRESS_RULE_IDS.some((id) => id in guard.rules)) return null;
  return {
    id: "wordpress-probes",
    ruleIds: WORDPRESS_RULE_IDS,
    title: "Block WordPress probes?",
    description:
      "Requests for wp-login.php, wp-admin, xmlrpc.php and wp-config.php are almost always scanners on a site that isn't WordPress. If this app is WordPress, keep them off.",
  };
}

/** The guard after an answer: true switches the rules on, false records that they stay off. */
export function answerSuggestion(guard: AppProbeGuard, suggestion: ProbeSuggestion, block: boolean): AppProbeGuard {
  return { ...guard, rules: { ...guard.rules, ...Object.fromEntries(suggestion.ruleIds.map((id) => [id, block])) } };
}
