import { describe, it, expect } from "vitest";
import { parseEnvContent } from "@/lib/env/parse-env-content";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { formatEnvVar, formatEnvContent, scanEnv } from "@/lib/env/dotenv";
import { orgEnvToContent, SECRET_MASK } from "@/lib/env/org-env-content";
import { regenerateSecrets } from "@/lib/env/environment-env";

// Today's shapes. The expected values were produced by the line-based parser before multi-line support.
const TODAY = [
  "A=1",
  'B="x y"',
  "C='z'",
  "D=a=b",
  "E=",
  "F=#x",
  "# comment",
  "",
  "  G = spaced ",
  'I="a" # n',
  "J=$HOME",
  'K="C:\\dir\\"',
  "L=\\n",
  "O=he said \"hi\"",
  "R=v\"",
  "S=pa$$word",
  'T="a\\nb"',
  "U=''",
  'V=""',
  "W=\"it's\"",
  "X=a b  c",
  "1bad=x",
  "not a pair",
].join("\n");

const TODAY_STRICT = [
  ["A", "1"], ["B", "x y"], ["C", "z"], ["D", "a=b"], ["E", ""], ["F", "#x"],
  ["J", "$HOME"], ["L", "\\n"], ["O", 'he said "hi"'], ["R", 'v"'],
  ["S", "pa$$word"], ["T", "a\\nb"], ["U", ""], ["V", ""], ["W", "it's"], ["X", "a b  c"],
  ["I", '"a" # n'], ["K", 'C:\\dir\\'],
].sort();

describe("single-line env content reads as it always has", () => {
  it("strict parser", () => {
    const got = parseEnvContent(TODAY).map((v) => [v.key, v.value]).sort();
    expect(got).toEqual(TODAY_STRICT);
  });

  it("loose parser keeps odd keys and untrimmed values", () => {
    const map = parseEnvToMap(TODAY);
    expect(map["1bad"]).toBe("x");
    expect(map.G).toBe(" spaced");
    expect(map.K).toBe('"C:\\dir\\"'.slice(1, -1));
    expect(Object.keys(map)).not.toContain("not a pair");
  });

  it("formats a plain value as KEY=value, byte for byte", () => {
    for (const [key, value] of TODAY_STRICT) {
      if (value.startsWith('"') || value.startsWith("'")) continue;
      expect(formatEnvVar(key, value)).toBe(`${key}=${value}`);
    }
  });
});

describe("multi-line values", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nAQAB==\n-----END PRIVATE KEY-----\n";
  const JSON_CRED = '{\n  "type": "service_account",\n  "private_key": "-----BEGIN-----\\nabc\\n-----END-----\\n"\n}';

  it("reads a pasted quoted block", () => {
    const text = `PRIVATE_KEY="${PEM}"\nAFTER=ok`;
    expect(parseEnvToMap(text)).toEqual({ PRIVATE_KEY: PEM, AFTER: "ok" });
    expect(parseEnvContent(text)).toEqual([{ key: "PRIVATE_KEY", value: PEM }, { key: "AFTER", value: "ok" }]);
  });

  it("round-trips a PEM key and a JSON credential through the formatter", () => {
    for (const value of [PEM, JSON_CRED]) {
      const text = `BEFORE=1\n${formatEnvVar("SECRET_BLOB", value)}\nAFTER=2`;
      expect(parseEnvToMap(text)).toEqual({ BEFORE: "1", SECRET_BLOB: value, AFTER: "2" });
    }
  });

  it("round-trips adversarial values", () => {
    const values = [
      "", " ", "  lead", "trail  ", '"', "'", '"q"', "'q'", '"half', "half\"", "a\nb", "\n", "\n\n", "a\r\nb", "tail\\", "\\",
      "\\\n", 'ends with quote"\nsecond', '"\nx', "x\n\"", "a\\nb\nc", 'KEY="v"\nOTHER=2', "# not a comment\nx=1", "\\\"\n\\\\",
      "line\n  indented\n\ttabbed", "emoji 🔑\nline", "$HOME\n${X}",
    ];
    for (const value of values) {
      expect(parseEnvToMap(formatEnvVar("K", value)).K).toBe(value);
      expect(parseEnvContent(formatEnvVar("K", value))[0].value).toBe(value);
    }
  });

  it("round-trips random strings alongside neighbors", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = ['a', 'b', ' ', '\n', '\r', '"', "'", '\\', '=', '#', '$', '\t', 'é'];
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rnd() * 12);
      let value = "";
      for (let j = 0; j < len; j++) value += alphabet[Math.floor(rnd() * alphabet.length)];
      const text = formatEnvContent([{ key: "A", value: "1" }, { key: "K", value }, { key: "Z", value: "last" }]);
      expect(parseEnvToMap(text)).toEqual({ A: "1", K: value, Z: "last" });
    }
  });

  it("leaves an opening quote that never closes as it always was", () => {
    expect(parseEnvContent('H="open\nB=2')).toEqual([{ key: "H", value: '"open' }, { key: "B", value: "2" }]);
  });

  it("keeps the next variable out of a value closed on its own line", () => {
    expect(parseEnvToMap('A="x"\nB="y"')).toEqual({ A: "x", B: "y" });
  });
});

describe("org editor content", () => {
  it("shows a multi-line value as a block and a secret as the mask", () => {
    const content = orgEnvToContent([
      { key: "NOTE", value: "a\nb", isSecret: false },
      { key: "TLS_PRIVATE_KEY", value: "-----BEGIN-----\nx\n-----END-----", isSecret: true },
      { key: "PLAIN", value: "v", isSecret: null },
    ]);
    expect(content).toContain(`TLS_PRIVATE_KEY=${SECRET_MASK}\n`);
    expect(content).not.toContain("BEGIN");
    expect(parseEnvContent(content)).toEqual([
      { key: "NOTE", value: "a\nb" },
      { key: "TLS_PRIVATE_KEY", value: SECRET_MASK },
      { key: "PLAIN", value: "v" },
    ]);
  });
});

describe("regenerateSecrets", () => {
  it("replaces a whole multi-line secret and leaves its neighbors", () => {
    const content = `A=1\n${formatEnvVar("JWT_PRIVATE_KEY", "-----BEGIN-----\nx\n-----END-----")}\nB=2\nDB_PASSWORD=hunter2`;
    const { content: next, regenerated } = regenerateSecrets(content, new Map());
    expect(regenerated).toEqual(["JWT_PRIVATE_KEY", "DB_PASSWORD"]);
    const map = parseEnvToMap(next);
    expect(Object.keys(map)).toEqual(["A", "JWT_PRIVATE_KEY", "B", "DB_PASSWORD"]);
    expect(map.JWT_PRIVATE_KEY).not.toContain("BEGIN");
    expect(map.B).toBe("2");
  });

  it("scans text lines through untouched", () => {
    expect(scanEnv("# c\n\nA=1", "loose").map((s) => s.kind)).toEqual(["text", "text", "var"]);
  });
});

describe("maskEnvContent", () => {
  it("hides values line by line as before and collapses a block", async () => {
    const { maskEnvContent } = await import("@/lib/env/mask-env");
    const text = `# keep\nA=1\nB=x=y\n${formatEnvVar("PEM", "-----BEGIN-----\nsecret\n-----END-----")}\nC=3\nplain line`;
    const masked = maskEnvContent(text);
    expect(masked).toBe("# keep\nA=••••••••\nB=••••••••\nPEM=••••••••\nC=••••••••\n••••••••");
    expect(masked).not.toContain("secret");
  });

  it("hides commented-out values and credentials in comments", async () => {
    const { maskEnvContent } = await import("@/lib/env/mask-env");
    const masked = maskEnvContent("# DB_PASSWORD=hunter2\n#OLD = abc\n# see https://u:p4ss@example.com\n# plain note");
    expect(masked).toBe("# DB_PASSWORD=••••••••\n#OLD=••••••••\n# ••••••••\n# plain note");
  });

  it("hides the rest of a multi-line value that never closes", async () => {
    const { maskEnvContent } = await import("@/lib/env/mask-env");
    const masked = maskEnvContent("KEY='-----BEGIN KEY-----\nMIIEsecretbody\n-----END KEY-----'\nB=2");
    expect(masked).not.toContain("MIIEsecretbody");
    expect(masked).toBe("KEY=••••••••\n••••••••\n••••••••\nB=••••••••");
  });
});

describe("restoreMaskedEnv", () => {
  it("puts stored values back under the mask and keeps edits", async () => {
    const { maskEnvContent, restoreMaskedEnv } = await import("@/lib/env/mask-env");
    const pem = formatEnvVar("PEM", "-----BEGIN-----\nsecret\n-----END-----");
    const stored = `A=1\n${pem}\nB=2`;
    const edited = maskEnvContent(stored).replace("B=••••••••", "B=new") + "\nC=3";
    expect(restoreMaskedEnv(edited, stored)).toBe(`A=1\n${pem}\nB=new\nC=3`);
  });

  it("restores masked comments and continuation lines", async () => {
    const { maskEnvContent, restoreMaskedEnv } = await import("@/lib/env/mask-env");
    const stored = "# DB_PASSWORD=hunter2\nKEY='a\nsecret\nb'\nB=2";
    expect(restoreMaskedEnv(maskEnvContent(stored), stored)).toBe(stored);
  });

  it("drops a masked key with nothing stored", async () => {
    const { restoreMaskedEnv } = await import("@/lib/env/mask-env");
    expect(restoreMaskedEnv("A=1\nX=••••••••", "A=0")).toBe("A=1");
  });
});
