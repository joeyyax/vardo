import { readFileSync } from "node:fs";
import { run } from "./cli";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a line from the terminal without echoing it. */
function promptSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const done = (exitCode?: number) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (exitCode !== undefined) process.exit(exitCode);
      resolve(value);
    };
    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdinIsTTY: process.stdin.isTTY === true,
  readStdin,
  promptSecret,
  readFile: (path) => readFileSync(path, "utf8"),
  fetch,
  now: Date.now,
  width: Math.min(process.stdout.columns || 100, 120),
}).then((code) => {
  process.exitCode = code;
});
