// A short-lived NUT session over TCP: connect, optional STARTTLS and login names, read-only queries, LOGOUT and close.

import net from "node:net";
import tls from "node:tls";
import {
  LineBuffer,
  NutProtocolError,
  ReplyCollector,
  expectOk,
  parseGetVar,
  parseListUps,
  parseListVar,
  quoteArg,
  type NutUps,
} from "./protocol";

export type NutTarget = {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  /** Upgrade with STARTTLS before sending credentials. */
  tls?: boolean;
};

export type NutSession = {
  ver(): Promise<string>;
  listUps(): Promise<NutUps[]>;
  listVar(ups: string): Promise<Record<string, string>>;
  getVar(ups: string, name: string): Promise<string>;
};

/** Whole-session budget: connect, handshake and every query. */
export const SESSION_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 5_000;

type Pending = { collector: ReplyCollector; resolve: (lines: string[]) => void; reject: (err: Error) => void };

class Connection {
  private socket: net.Socket;
  private buffer = new LineBuffer();
  private pending: Pending | null = null;
  private failure: Error | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new NutProtocolError("Connection closed by the NUT server")));
  }

  private onData(chunk: string): void {
    let lines: string[];
    try {
      lines = this.buffer.push(chunk);
    } catch (err) {
      this.fail(err as Error);
      return;
    }
    for (const line of lines) {
      const pending = this.pending;
      if (!pending) continue;
      try {
        const reply = pending.collector.feed(line);
        if (reply) {
          this.pending = null;
          pending.resolve(reply);
        }
      } catch (err) {
        this.pending = null;
        pending.reject(err as Error);
      }
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);
  }

  send(command: string, list = false): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new NutProtocolError("A command is already in flight"));
    return new Promise((resolve, reject) => {
      this.pending = { collector: new ReplyCollector(list), resolve, reject };
      this.socket.write(`${command}\n`);
    });
  }

  /** Swaps the socket for a TLS one over it after `OK STARTTLS`. */
  async startTls(host: string): Promise<void> {
    expectOk((await this.send("STARTTLS"))[0]);
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("close");
    raw.removeAllListeners("error");
    raw.on("error", () => {});
    const secure = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    this.socket = secure;
    this.buffer = new LineBuffer();
    this.attach(secure);
  }

  close(): void {
    this.socket.destroy();
  }
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new NutProtocolError(`Timed out connecting to ${host}:${port}`));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

/** Runs `fn` in one session and always closes the socket. Rejects when the whole session overruns `timeoutMs`. */
export async function withNutSession<T>(target: NutTarget, fn: (session: NutSession) => Promise<T>, timeoutMs = SESSION_TIMEOUT_MS): Promise<T> {
  let conn: Connection | null = null;
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    const socket = await connect(target.host, target.port);
    if (done) {
      socket.destroy();
      throw new NutProtocolError("Session ended before it connected");
    }
    conn = new Connection(socket);
    if (target.tls) await conn.startTls(target.host);
    if (target.username) expectOk((await conn.send(`USERNAME ${quoteArg(target.username)}`))[0]);
    if (target.password) expectOk((await conn.send(`PASSWORD ${quoteArg(target.password)}`))[0]);
    const c = conn;
    const session: NutSession = {
      ver: async () => (await c.send("VER"))[0],
      listUps: async () => parseListUps(await c.send("LIST UPS", true)),
      listVar: async (ups) => parseListVar(await c.send(`LIST VAR ${quoteArg(ups)}`, true), ups),
      getVar: async (ups, name) => parseGetVar((await c.send(`GET VAR ${quoteArg(ups)} ${quoteArg(name)}`))[0], ups, name),
    };
    const result = await fn(session);
    await c.send("LOGOUT").catch(() => {});
    return result;
  };
  const running = run();
  running.catch(() => {});
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NutProtocolError(`Timed out after ${timeoutMs / 1000}s talking to ${target.host}:${target.port}`)), timeoutMs);
      }),
    ]);
  } finally {
    done = true;
    clearTimeout(timer);
    (conn as Connection | null)?.close();
  }
}
