import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { withNutSession } from "@/lib/ups/client";
import { NutError } from "@/lib/ups/protocol";

type Script = (command: string, socket: net.Socket) => void;

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

async function fakeNut(script: Script): Promise<{ port: number; received: string[]; closed: Promise<void> }> {
  const received: string[] = [];
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => markClosed());
    let tail = "";
    socket.on("data", (chunk) => {
      const parts = (tail + chunk.toString()).split("\n");
      tail = parts.pop() ?? "";
      for (const line of parts) {
        received.push(line);
        script(line, socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, received, closed };
}

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Writes a reply in small pieces so lines arrive split across reads. */
function dribble(socket: net.Socket, text: string) {
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    socket.write(text.slice(i, i + 7));
    i += 7;
    setTimeout(step, 1);
  };
  step();
}

describe("withNutSession", () => {
  it("logs in, reads a list split across reads, logs out and closes", async () => {
    const nut = await fakeNut((cmd, socket) => {
      if (cmd.startsWith("USERNAME") || cmd.startsWith("PASSWORD")) socket.write("OK\n");
      else if (cmd === "LIST VAR rack") dribble(socket, 'BEGIN LIST VAR rack\nVAR rack ups.status "OB LB"\nVAR rack battery.charge "12"\nEND LIST VAR rack\n');
      else if (cmd === "LOGOUT") socket.end("OK Goodbye\n");
    });

    const vars = await withNutSession({ host: "127.0.0.1", port: nut.port, username: "mon", password: "pa ss" }, (s) => s.listVar("rack"));

    expect(vars).toEqual({ "ups.status": "OB LB", "battery.charge": "12" });
    expect(nut.received).toEqual(["USERNAME mon", 'PASSWORD "pa ss"', "LIST VAR rack", "LOGOUT"]);
    await nut.closed;
  });

  it("surfaces an ERR reply and still closes the socket", async () => {
    const nut = await fakeNut((cmd, socket) => {
      if (cmd.startsWith("LIST VAR")) socket.write("ERR UNKNOWN-UPS\n");
    });
    await expect(withNutSession({ host: "127.0.0.1", port: nut.port }, (s) => s.listVar("nope"))).rejects.toEqual(new NutError("UNKNOWN-UPS"));
    await nut.closed;
  });

  it("times out a server that never answers and closes the socket", async () => {
    const nut = await fakeNut(() => {});
    const started = Date.now();
    await expect(withNutSession({ host: "127.0.0.1", port: nut.port }, (s) => s.ver(), 200)).rejects.toThrow(/Timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
    await nut.closed;
  });

  it("fails when the server hangs up mid-list", async () => {
    const nut = await fakeNut((cmd, socket) => {
      if (cmd.startsWith("LIST VAR")) socket.end('BEGIN LIST VAR rack\nVAR rack ups.status "OL"\n');
    });
    await expect(withNutSession({ host: "127.0.0.1", port: nut.port }, (s) => s.listVar("rack"))).rejects.toThrow(/closed/);
  });

  it("fails fast when nothing listens", async () => {
    const nut = await fakeNut(() => {});
    const port = nut.port;
    await new Promise((r) => servers.pop()!.close(r));
    await expect(withNutSession({ host: "127.0.0.1", port }, (s) => s.ver())).rejects.toThrow(/ECONNREFUSED/);
  });
});
