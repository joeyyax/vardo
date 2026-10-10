import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, visit, type Document, type Pair } from "yaml";
import { redactSecrets } from "@/lib/redact";

// Masks compose `environment:` values for callers who can't reveal secrets.

export const ENV_MASK = "********";

/** Only `${VAR}` or `$VAR` references, which carry no secret. */
const REFS_ONLY = /^\s*(?:(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s*)+$/;

const STRINGIFY = { lineWidth: 0 } as const;

export class MaskedComposeError extends Error {}

type Entry = {
  key: string;
  value: unknown;
  set: (value: unknown) => void;
};

function parse(content: string): Document | null {
  try {
    const doc = parseDocument(content);
    return doc.errors.length > 0 ? null : doc;
  } catch {
    return null;
  }
}

/** Every `environment:` map or list, through aliases and merge keys. */
function envNodes(doc: Document): Set<unknown> {
  const out = new Set<unknown>();
  const add = (node: unknown): void => {
    const target = isAlias(node) ? node.resolve(doc) : node;
    if (!target || out.has(target)) return;
    if (isSeq(target)) {
      out.add(target);
    } else if (isMap(target)) {
      out.add(target);
      for (const pair of target.items) {
        if (!isScalar(pair.key) || pair.key.value !== "<<") continue;
        if (isSeq(pair.value)) pair.value.items.forEach(add);
        else add(pair.value);
      }
    }
  };
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === "environment") add(pair.value);
    },
  });
  return out;
}

/** Each env node keyed by its path from the root. */
function locate(doc: Document, targets: Set<unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): void => {
    if (!node || isAlias(node) || seen.has(node)) return;
    seen.add(node);
    if (targets.has(node)) out.set(path, node);
    if (isMap(node)) {
      for (const pair of node.items) walk(pair.value, `${path}/${isScalar(pair.key) ? String(pair.key.value) : "?"}`);
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, `${path}/${i}`));
    }
  };
  walk(doc.contents, "");
  return out;
}

function entries(node: unknown): Entry[] {
  const out: Entry[] = [];
  if (isMap(node)) {
    for (const pair of node.items as Pair<unknown, unknown>[]) {
      if (!isScalar(pair.key) || pair.key.value === "<<") continue;
      const value = isScalar(pair.value) ? pair.value.value : pair.value;
      out.push({
        key: String(pair.key.value),
        value,
        set: (v) => {
          pair.value = new Scalar(v);
        },
      });
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const eq = item.value.indexOf("=");
      if (eq < 0) continue;
      const key = item.value.slice(0, eq);
      out.push({
        key,
        value: item.value.slice(eq + 1),
        set: (v) => {
          item.value = `${key}=${String(v)}`;
        },
      });
    }
  }
  return out;
}

function maskable(value: unknown): boolean {
  if (value == null || value === "") return false;
  return !(typeof value === "string" && REFS_ONLY.test(value));
}

/** Compose with every `environment:` value masked. Keys and references stay. */
export function maskComposeEnv(content: string): string {
  const doc = parse(content);
  if (!doc) return redactSecrets(content);

  let changed = false;
  for (const node of envNodes(doc)) {
    for (const entry of entries(node)) {
      if (!maskable(entry.value)) continue;
      entry.set(ENV_MASK);
      changed = true;
    }
  }
  return changed ? doc.toString(STRINGIFY) : content;
}

/** Puts saved values back where an edit kept the mask. Throws when one has no saved value. */
export function unmaskComposeEnv(next: string, previous: string | null | undefined): string {
  if (!next.includes(ENV_MASK)) return next;
  const doc = parse(next);
  if (!doc) return next;

  const saved = new Map<string, unknown>();
  const prevDoc = previous ? parse(previous) : null;
  if (prevDoc) {
    for (const [path, node] of locate(prevDoc, envNodes(prevDoc))) {
      for (const entry of entries(node)) saved.set(`${path}\0${entry.key}`, entry.value);
    }
  }

  let changed = false;
  for (const [path, node] of locate(doc, envNodes(doc))) {
    for (const entry of entries(node)) {
      if (entry.value !== ENV_MASK) continue;
      const id = `${path}\0${entry.key}`;
      if (!saved.has(id)) {
        throw new MaskedComposeError(`${entry.key} is masked and has no saved value. Enter its value.`);
      }
      entry.set(saved.get(id));
      changed = true;
    }
  }
  return changed ? doc.toString(STRINGIFY) : next;
}
