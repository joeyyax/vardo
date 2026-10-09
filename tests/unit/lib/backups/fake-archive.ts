// Fakes for the streaming backup path: real tar.gz bytes, a spawned producer and a storage sink.

import { EventEmitter } from "events";
import { PassThrough, type Readable } from "stream";
import { gzipSync } from "zlib";

function tarHeader(name: string, size: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "ascii");
  h.write("0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0" + "00", 257, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/** An uncompressed tar of the given directories and files. */
export function tar(entries: { dirs?: string[]; files?: Record<string, string | Buffer> }): Buffer {
  const parts: Buffer[] = [];
  for (const dir of entries.dirs ?? []) parts.push(tarHeader(dir.endsWith("/") ? dir : `${dir}/`, 0, "5"));
  for (const [name, body] of Object.entries(entries.files ?? {})) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    parts.push(tarHeader(name, data.length, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tarGz(entries: Parameters<typeof tar>[0]): Buffer {
  return gzipSync(tar(entries));
}

/** A tar.gz with one file, comfortably over the size floor. */
export const VALID_ARCHIVE = tarGz({ dirs: ["./"], files: { "./data.bin": "x".repeat(4096) } });

export type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };

/** A child process that writes `stdout`, then exits with `code`. */
export function fakeChild(opts: { stdout?: Buffer; code?: number; stderr?: string } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  setImmediate(() => {
    if (opts.stderr) child.stderr.write(opts.stderr);
    child.stderr.end();
    child.stdout.end(opts.stdout ?? Buffer.alloc(0));
    child.stdout.once("end", () => setImmediate(() => child.emit("close", opts.code ?? 0, null)));
  });
  return child;
}

/** A storage sink that records only what it committed: a stream that ended cleanly. */
export function recordingUpload(committed: { key: string; bytes: Buffer }[]) {
  return async (key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    committed.push({ key, bytes });
    return { sizeBytes: bytes.length };
  };
}
