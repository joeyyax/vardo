// Parses a Traefik router rule into the hostnames it can match.

import { isHostname } from "@/lib/security/hostname";

/** What one matcher claims: a host, every subdomain of a zone, every host, or something unreadable. */
export type HostClaim =
  | { kind: "host"; host: string }
  | { kind: "zone"; zone: string }
  | { kind: "any"; reason: string }
  | { kind: "unknown"; reason: string };

export type RuleNode =
  | { op: "claims"; claims: HostClaim[] }
  | { op: "and" | "or"; left: RuleNode; right: RuleNode }
  | { op: "not"; node: RuleNode };

const HOST_MATCHERS = new Set(["host", "hostsni"]);
const REGEXP_MATCHERS = new Set(["hostregexp", "hostsniregexp"]);

class RuleSyntaxError extends Error {}

type Token =
  | { t: "ident"; v: string }
  | { t: "str"; v: string }
  | { t: "(" | ")" | "," | "&&" | "||" | "!" };

function tokenize(rule: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < rule.length) {
    const c = rule[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === "," || c === "!") { out.push({ t: c }); i++; continue; }
    if (rule.startsWith("&&", i) || rule.startsWith("||", i)) {
      out.push({ t: rule.slice(i, i + 2) as "&&" | "||" });
      i += 2;
      continue;
    }
    if (c === "`" || c === '"') {
      const end = rule.indexOf(c, i + 1);
      if (end < 0) throw new RuleSyntaxError("unterminated string");
      const raw = rule.slice(i + 1, end);
      if (c === '"' && raw.includes("\\")) throw new RuleSyntaxError("escaped string");
      out.push({ t: "str", v: raw });
      i = end + 1;
      continue;
    }
    const m = /^[A-Za-z][A-Za-z0-9]*/.exec(rule.slice(i));
    if (!m) throw new RuleSyntaxError(`unexpected "${c}"`);
    out.push({ t: "ident", v: m[0] });
    i += m[0].length;
  }
  return out;
}

/** The literal hostname or zone a host regexp is pinned to. */
export function regexpClaim(pattern: string): HostClaim {
  const unknown = { kind: "unknown", reason: `regexp \`${pattern}\` isn't pinned to a domain` } as const;
  let p = pattern.replace(/^\(\?i\)/, "");
  if (!p.endsWith("$") || p.endsWith("\\$") || /[|{}]/.test(p)) return unknown;
  p = p.slice(0, -1);
  // Read literal hostname characters back from the end.
  let tail = "";
  let i = p.length - 1;
  while (i >= 0) {
    const c = p[i];
    const escaped = i > 0 && p[i - 1] === "\\" && !(i > 1 && p[i - 2] === "\\");
    if (c === "." && escaped) { tail = "." + tail; i -= 2; continue; }
    if (/[A-Za-z0-9-]/.test(c) && !escaped) { tail = c + tail; i--; continue; }
    break;
  }
  const head = p.slice(0, i + 1);
  if (head === "^" || head === "") {
    const host = tail.toLowerCase();
    return head === "^" && isHostname(host) ? { kind: "host", host } : unknown;
  }
  // Anything before the tail must end at a label boundary.
  if (!tail.startsWith(".")) return unknown;
  const zone = tail.slice(1).toLowerCase();
  return zone.includes(".") && isHostname(zone) ? { kind: "zone", zone } : unknown;
}

function hostClaim(matcher: string, arg: string): HostClaim {
  if (matcher === "hostsni" && arg === "*") return { kind: "any", reason: "HostSNI(`*`) matches every host" };
  const host = arg.toLowerCase().replace(/\.$/, "");
  return isHostname(host) ? { kind: "host", host } : { kind: "unknown", reason: `"${arg}" isn't a hostname` };
}

function matcherClaims(name: string, args: string[]): HostClaim[] {
  const m = name.toLowerCase();
  if (HOST_MATCHERS.has(m)) return args.map((a) => hostClaim(m, a));
  if (REGEXP_MATCHERS.has(m)) return args.map(regexpClaim);
  return [{ kind: "any", reason: `${name}(...) doesn't restrict the host` }];
}

/** Parses a rule. Throws on syntax Vardo can't read. */
export function parseRule(rule: string): RuleNode {
  const tokens = tokenize(rule);
  let pos = 0;
  const peek = () => tokens[pos];
  const expect = (t: Token["t"]) => {
    if (peek()?.t !== t) throw new RuleSyntaxError(`expected ${t}`);
    return tokens[pos++];
  };

  const unary = (): RuleNode => {
    const tok = peek();
    if (!tok) throw new RuleSyntaxError("unexpected end");
    if (tok.t === "!") { pos++; return { op: "not", node: unary() }; }
    if (tok.t === "(") { pos++; const n = or(); expect(")"); return n; }
    if (tok.t !== "ident") throw new RuleSyntaxError(`unexpected ${tok.t}`);
    pos++;
    expect("(");
    const args: string[] = [];
    if (peek()?.t !== ")") {
      for (;;) {
        args.push((expect("str") as { v: string }).v);
        if (peek()?.t !== ",") break;
        pos++;
      }
    }
    expect(")");
    if (args.length === 0) throw new RuleSyntaxError(`${tok.v}() has no argument`);
    return { op: "claims", claims: matcherClaims(tok.v, args) };
  };
  const and = (): RuleNode => {
    let n = unary();
    while (peek()?.t === "&&") { pos++; n = { op: "and", left: n, right: unary() }; }
    return n;
  };
  const or = (): RuleNode => {
    let n = and();
    while (peek()?.t === "||") { pos++; n = { op: "or", left: n, right: and() }; }
    return n;
  };

  const node = or();
  if (pos !== tokens.length) throw new RuleSyntaxError("trailing input");
  return node;
}

/** Ranked from best to worst for the deploying org. */
export type ClaimVerdict = "owned" | "uncertain" | "unowned" | "foreign" | "any";

export type JudgedRule = {
  verdict: ClaimVerdict;
  /** The claims the verdict rests on, each with its own verdict. */
  claims: { claim: HostClaim; verdict: ClaimVerdict }[];
};

const WORST: ClaimVerdict[] = ["any", "foreign", "unowned", "uncertain", "owned"];

/** Judges a parsed rule. An `&&` is owned when either side is; an `||` only when both are. */
export function judgeRule(node: RuleNode, judge: (claim: HostClaim) => ClaimVerdict): JudgedRule {
  switch (node.op) {
    case "claims": {
      const claims = node.claims.map((claim) => ({ claim, verdict: judge(claim) }));
      const verdict = WORST.find((v) => claims.some((c) => c.verdict === v)) ?? "owned";
      return { verdict, claims };
    }
    case "not":
      return { verdict: "any", claims: [{ claim: { kind: "any", reason: "a negated matcher matches every other host" }, verdict: "any" }] };
    case "or": {
      const l = judgeRule(node.left, judge);
      const r = judgeRule(node.right, judge);
      const verdict = WORST.find((v) => l.verdict === v || r.verdict === v)!;
      return { verdict, claims: [...l.claims, ...r.claims] };
    }
    case "and": {
      const l = judgeRule(node.left, judge);
      const r = judgeRule(node.right, judge);
      const sides = [l, r];
      // The matched set sits inside each side, so the most specific side decides.
      for (const v of ["owned", "foreign", "unowned", "uncertain"] as const) {
        const side = sides.find((s) => s.verdict === v);
        if (side) return side;
      }
      return { verdict: "any", claims: [...l.claims, ...r.claims] };
    }
  }
}

export { RuleSyntaxError };
