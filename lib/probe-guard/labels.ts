// What a guarded hit counts under: a managed rule, a template's turn-away entries, the owner's own, or other paths. Client-safe.

import { matchBlock, type CustomBlock } from "./blocks";
import { OTHER_RULE_ID, matchProbe, ruleLabel } from "./rules";
import { findTemplate } from "./templates";

/** Rule id counted for a hit on an owner's own turn-away entry. */
export const CUSTOM_RULE_ID = "custom";
export const CUSTOM_PROBE_LABEL = "turn-away entries";
const TEMPLATE_PREFIX = "template:";

/** Turn-away entries by app id. */
export type BlocksByApp = ReadonlyMap<string, readonly CustomBlock[]>;

/** The rule id a path counts under, given the turn-away entries that applied to it. */
export function hitRuleId(path: string, blocks: readonly CustomBlock[] = []): string {
  const rule = matchProbe(path)?.rule;
  if (rule) return rule.id;
  const block = matchBlock(path, blocks);
  if (!block) return OTHER_RULE_ID;
  return block.template ? `${TEMPLATE_PREFIX}${block.template}` : CUSTOM_RULE_ID;
}

/** The label a counted rule id shows as. */
export function hitLabel(id: string): string {
  if (id === CUSTOM_RULE_ID) return CUSTOM_PROBE_LABEL;
  if (id.startsWith(TEMPLATE_PREFIX)) return findTemplate(id.slice(TEMPLATE_PREFIX.length))?.name ?? CUSTOM_PROBE_LABEL;
  return ruleLabel(id);
}

/** Labels paths with each app's turn-away entries. */
export function pathLabeler(blocksByApp: BlocksByApp = new Map()): (path: string, appId: string | null) => string {
  return (path, appId) => hitLabel(hitRuleId(path, appId ? blocksByApp.get(appId) : undefined));
}
