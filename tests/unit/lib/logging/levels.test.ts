import { describe, it, expect } from "vitest";
import {
  detectLevel,
  assignLevels,
  countLevels,
  filterByLevel,
  httpStatus,
  type LogLevel,
} from "@/lib/logging/levels";

describe("detectLevel", () => {
  it("reads Vardo deploy markers", () => {
    expect(detectLevel("[deploy] Starting build")).toBe("info");
    expect(detectLevel("[error] compose failed")).toBe("error");
    expect(detectLevel("[compat] rewriting ports")).toBe("warn");
    expect(detectLevel("[health] container healthy")).toBe("info");
  });

  it("reads nginx error log severities", () => {
    expect(detectLevel("2026/07/29 06:12:55 [notice] 1#1: start worker process 29")).toBe("info");
    expect(detectLevel("2026/07/29 06:12:55 [warn] 1#1: conflicting server name")).toBe("warn");
    expect(detectLevel("2026/07/29 06:12:55 [crit] 1#1: bind() failed")).toBe("error");
    expect(detectLevel("2026/07/29 06:12:55 [emerg] 1#1: no such file")).toBe("error");
  });

  it("reads redis level characters", () => {
    expect(detectLevel("1:M 02 Aug 2026 02:45:11.039 * Background saving started by pid 93")).toBe("info");
    expect(detectLevel("93:C 02 Aug 2026 02:45:11.087 . DB saved on disk")).toBe("debug");
    expect(detectLevel("1:M 02 Aug 2026 02:45:11.039 # Config file not found")).toBe("warn");
  });

  it("reads postgres severities", () => {
    expect(detectLevel('2026-08-02 02:58:51.523 UTC [93132] FATAL:  password authentication failed')).toBe("error");
    expect(detectLevel("2026-08-02 02:58:51.523 UTC [93132] LOG:  database system is ready")).toBe("info");
  });

  it("reads mysql bracket severities", () => {
    expect(detectLevel("2026-07-29T06:12:56.898090Z 0 [System] [MY-010232] [Server] XA crash recovery finished.")).toBe("info");
    expect(detectLevel("2026-07-29T06:12:56.929614Z 0 [Warning] [MY-010068] CA certificate is self signed.")).toBe("warn");
  });

  it("reads Python exceptions and warnings", () => {
    expect(detectLevel("django.db.utils.OperationalError: pool error")).toBe("error");
    expect(detectLevel("/usr/lib/importlib.py:88: RuntimeWarning: SECRET_KEY is the default")).toBe("warn");
  });

  it("grades access log lines by status", () => {
    expect(detectLevel('::1 - - [29/Jul/2026] "GET / HTTP/1.1" 200 79646')).toBe("info");
    expect(detectLevel('::1 - - [29/Jul/2026] "GET /nope HTTP/1.1" 404 153')).toBe("warn");
    expect(detectLevel('::1 - - [29/Jul/2026] "POST /api HTTP/1.1" 502 0')).toBe("error");
  });

  it("does not read a response size as a status code", () => {
    expect(detectLevel('::1 - - [29/Jul/2026] "GET / HTTP/1.1" 200 504')).toBe("info");
  });

  it("leaves unrecognized output as other", () => {
    expect(detectLevel("Start GlitchTip with 1 granian worker(s) (asginl)")).toBe("other");
    expect(detectLevel("params: []")).toBe("other");
  });

  it("keeps continuation lines with the line they belong to", () => {
    expect(detectLevel('  File "/app/main.py", line 3, in <module>', "error")).toBe("error");
    expect(detectLevel("2026-08-02 02:58:51 UTC [1] DETAIL:  Role does not exist.", "error")).toBe("error");
    expect(detectLevel('  File "/app/main.py", line 3')).toBe("other");
  });
});

describe("httpStatus", () => {
  it("finds structured and bare status codes", () => {
    expect(httpStatus('"GET /a HTTP/1.1" 301 0')).toBe(301);
    expect(httpStatus("status=503 duration=2ms")).toBe(503);
    expect(httpStatus("GET /health 200")).toBe(200);
    expect(httpStatus("no request here")).toBeNull();
  });
});

describe("assignLevels", () => {
  it("threads the level through a traceback", () => {
    expect(assignLevels([
      "Traceback (most recent call last):",
      '  File "/app/db.py", line 12',
      "    raise err",
    ])).toEqual(["error", "error", "error"]);
  });

  it("threads the level through a trailing exception", () => {
    expect(assignLevels([
      "django.db.utils.OperationalError: pool error",
      '  File "/app/db.py", line 12',
      "    raise err",
      "Enqueuing due task: uptime-dispatch-checks",
    ])).toEqual(["error", "error", "error", "other"]);
  });
});

describe("countLevels", () => {
  it("accounts for every line", () => {
    const lines = [
      { text: "[error] boom" },
      { text: "[deploy] ok" },
      { text: "plain output" },
      { text: "more plain output" },
    ];
    const counts = countLevels(lines);
    expect(counts).toEqual({ error: 1, warn: 0, info: 1, debug: 0, other: 2 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(lines.length);
  });

  it("trusts a level already assigned to the line", () => {
    expect(countLevels([{ text: "plain", level: "error" as LogLevel }]).error).toBe(1);
  });
});

describe("filterByLevel", () => {
  const lines = [
    { text: "[error] boom", level: "error" as LogLevel },
    { text: "plain", level: "other" as LogLevel },
    { text: "[deploy] ok", level: "info" as LogLevel },
  ];

  it("returns everything when nothing is selected", () => {
    expect(filterByLevel(lines, new Set())).toHaveLength(3);
  });

  it("keeps only the selected levels", () => {
    expect(filterByLevel(lines, new Set<LogLevel>(["error", "other"])).map((l) => l.level))
      .toEqual(["error", "other"]);
  });

  it("can select the other bucket on its own", () => {
    expect(filterByLevel(lines, new Set<LogLevel>(["other"]))).toHaveLength(1);
  });
});
