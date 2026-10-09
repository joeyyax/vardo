// The streaming pipeline's in-flight checks replace `gzip -t`, the post-hoc checksum pass and `tar tzf`.

import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "crypto";
import { PassThrough, Readable } from "stream";
import { pipeline } from "stream/promises";
import { gzipSync } from "zlib";
import { createArchiveInspector, TarMemberScanner, type ArchiveStats } from "@/lib/backups/archive-stream";
import { tar, tarGz } from "./fake-archive";

async function inspect(bytes: Buffer, opts: { tar?: boolean; chunk?: number; beforeEnd?: (s: ArchiveStats) => Promise<void> } = {}) {
  const chunk = opts.chunk ?? 1000;
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  const inspector = createArchiveInspector({ label: "Volume x", tar: opts.tar ?? true, beforeEnd: opts.beforeEnd });
  const out: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (c) => out.push(c));
  await pipeline(Readable.from(parts), inspector, sink);
  return { stats: inspector.stats!, out: Buffer.concat(out) };
}

describe("archive inspector", () => {
  it("passes bytes through unchanged and checksums them", async () => {
    const archive = tarGz({ files: { "./a": randomBytes(20_000) } });

    const { stats, out } = await inspect(archive);

    expect(out.equals(archive)).toBe(true);
    expect(stats.bytes).toBe(archive.length);
    expect(stats.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
  });

  it("fails a truncated gzip", async () => {
    const archive = tarGz({ files: { "./a": randomBytes(20_000) } });

    await expect(inspect(archive.subarray(0, archive.length - 100))).rejects.toThrow(/gzip check failed/);
  });

  it("fails bytes that are not gzip", async () => {
    await expect(inspect(Buffer.alloc(4096, 7))).rejects.toThrow(/gzip check failed/);
  });

  it("fails an empty stream", async () => {
    await expect(inspect(Buffer.alloc(0))).rejects.toThrow(/no data/);
  });

  it("fails the stream when the end hook throws, before the last byte leaves", async () => {
    const archive = tarGz({ files: { "./a": "x" } });
    const beforeEnd = async () => {
      throw new Error("producer exited 1");
    };

    await expect(inspect(archive, { beforeEnd })).rejects.toThrow("producer exited 1");
  });

  it("reports a tree of directories as holding no files", async () => {
    const { stats } = await inspect(tarGz({ dirs: ["./", "./a", "./a/b"] }));

    expect(stats.hasFiles).toBe(false);
  });

  it("finds a file behind directories, across chunk boundaries", async () => {
    const { stats } = await inspect(tarGz({ dirs: ["./", "./a"], files: { "./a/f": randomBytes(3000) } }), { chunk: 7 });

    expect(stats.hasFiles).toBe(true);
  });

  it("leaves hasFiles null for a dump", async () => {
    const { stats } = await inspect(gzipSync(randomBytes(500)), { tar: false });

    expect(stats.hasFiles).toBeNull();
  });
});

describe("tar member scanner", () => {
  it("skips file bodies, so data that looks like a header can't fool it", () => {
    const fakeHeader = tar({ files: { "./inner": "x" } }).subarray(0, 512);
    const archive = tar({ dirs: ["./"] });
    // A directory entry whose (ignored) payload is a regular-file header.
    const dir = Buffer.from(archive.subarray(0, 512));
    dir.write("00000001000\0", 124, "ascii");
    const scanner = new TarMemberScanner();

    scanner.write(Buffer.concat([dir, fakeHeader, Buffer.alloc(1024)]));

    expect(scanner.hasFiles).toBe(false);
  });

  it("treats GNU long-name and pax headers as metadata, not members", () => {
    const meta = Buffer.from(tar({ files: { "././@LongLink": "a".repeat(200) } }));
    meta.write("L", 156, "ascii");
    const pax = Buffer.from(tar({ files: { "./PaxHeader": "30 path=a\n" } }));
    pax.write("x", 156, "ascii");
    const scanner = new TarMemberScanner();

    scanner.write(Buffer.concat([meta.subarray(0, -1024), pax.subarray(0, -1024), tar({ dirs: ["./a"] })]));

    expect(scanner.hasFiles).toBe(false);
  });
});
