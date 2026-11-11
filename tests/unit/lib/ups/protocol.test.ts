import { describe, expect, it } from "vitest";
import {
  LineBuffer,
  NutError,
  NutProtocolError,
  ReplyCollector,
  errorCode,
  parseGetVar,
  parseListUps,
  parseListVar,
  quoteArg,
  tokenize,
} from "@/lib/ups/protocol";

describe("tokenize", () => {
  it("keeps spaces inside quotes and drops the quotes", () => {
    expect(tokenize('VAR ups ups.status "OL CHRG"')).toEqual(["VAR", "ups", "ups.status", "OL CHRG"]);
  });

  it("unescapes backslashed quotes and backslashes", () => {
    expect(tokenize('VAR ups ups.id "say \\"hi\\" \\\\ ok"')).toEqual(["VAR", "ups", "ups.id", 'say "hi" \\ ok']);
  });

  it("reads an empty quoted value as an empty word", () => {
    expect(tokenize('VAR ups ups.id ""')).toEqual(["VAR", "ups", "ups.id", ""]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => tokenize('VAR ups ups.status "OL')).toThrow(NutProtocolError);
  });

  it("rejects a trailing backslash inside quotes", () => {
    expect(() => tokenize('VAR ups x "abc\\')).toThrow(NutProtocolError);
  });
});

describe("quoteArg", () => {
  it("round-trips through tokenize", () => {
    for (const value of ["plain", "with space", 'q"uote', "back\\slash", ""]) {
      expect(tokenize(`USERNAME ${quoteArg(value)}`)).toEqual(["USERNAME", value]);
    }
  });

  it("refuses line breaks, which would smuggle a second command", () => {
    expect(() => quoteArg("x\nINSTCMD ups load.off")).toThrow(NutProtocolError);
  });
});

describe("LineBuffer", () => {
  it("holds a partial line until its newline arrives", () => {
    const buf = new LineBuffer();
    expect(buf.push('VAR ups battery.cha')).toEqual([]);
    expect(buf.pending).toBe(true);
    expect(buf.push('rge "90"\nVAR ups ups.load "2')).toEqual(['VAR ups battery.charge "90"']);
    expect(buf.push('4"\r\n')).toEqual(['VAR ups ups.load "24"']);
    expect(buf.pending).toBe(false);
  });

  it("refuses an endless line", () => {
    const buf = new LineBuffer(16);
    expect(() => buf.push("x".repeat(32))).toThrow(NutProtocolError);
  });
});

describe("errors", () => {
  it("reads the code, and a bare ERR as UNKNOWN", () => {
    expect(errorCode("ERR VAR-NOT-SUPPORTED")).toBe("VAR-NOT-SUPPORTED");
    expect(errorCode("ERR")).toBe("UNKNOWN");
    expect(errorCode("OK")).toBeNull();
  });

  it("GET VAR throws the server's ERR", () => {
    expect(() => parseGetVar("ERR UNKNOWN-UPS", "ups", "ups.status")).toThrow(new NutError("UNKNOWN-UPS"));
  });
});

const LIST_VAR = [
  "BEGIN LIST VAR 10.0.0.155",
  'VAR 10.0.0.155 battery.charge "90"',
  'VAR 10.0.0.155 ups.status "OL CHRG"',
  'VAR 10.0.0.155 ups.test.result "done and passed"',
  'VAR other ups.load "99"',
  "END LIST VAR 10.0.0.155",
];

describe("ReplyCollector", () => {
  it("finishes a list only at END LIST, fed one line at a time", () => {
    const c = new ReplyCollector(true);
    const results = LIST_VAR.map((line) => c.feed(line));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual(LIST_VAR);
  });

  it("finishes a list on an ERR in place of BEGIN", () => {
    expect(new ReplyCollector(true).feed("ERR UNKNOWN-UPS")).toEqual(["ERR UNKNOWN-UPS"]);
  });

  it("refuses a list reply that doesn't start with BEGIN", () => {
    expect(() => new ReplyCollector(true).feed('VAR ups x "1"')).toThrow(NutProtocolError);
  });
});

describe("parseListVar", () => {
  it("reads this UPS's variables and skips another's", () => {
    expect(parseListVar(LIST_VAR, "10.0.0.155")).toEqual({
      "battery.charge": "90",
      "ups.status": "OL CHRG",
      "ups.test.result": "done and passed",
    });
  });

  it("throws the ERR reply", () => {
    expect(() => parseListVar(["ERR UNKNOWN-UPS"], "nope")).toThrow(NutError);
  });

  it("refuses a block for a different UPS", () => {
    expect(() => parseListVar(LIST_VAR, "other")).toThrow(NutProtocolError);
  });
});

describe("parseListUps", () => {
  it("reads names and descriptions", () => {
    expect(parseListUps(["BEGIN LIST UPS", 'UPS rack "Rack UPS"', 'UPS desk "Desk"', "END LIST UPS"])).toEqual([
      { name: "rack", description: "Rack UPS" },
      { name: "desk", description: "Desk" },
    ]);
  });
});
