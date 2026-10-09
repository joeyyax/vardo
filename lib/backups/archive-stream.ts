// In-stream checks on a gzip archive on its way to storage: sha256, byte count, gzip integrity and tar members.

import { createHash } from "crypto";
import { Transform, type TransformCallback } from "stream";
import { createGunzip, type Gunzip } from "zlib";

/** What the inspector saw by the end of the stream. */
export type ArchiveStats = {
  /** Gzip bytes, before encryption. */
  bytes: number;
  /** Hex sha256 of the gzip bytes. */
  sha256: string;
  /** The tar held at least one non-directory member. Null when the payload isn't scanned as tar. */
  hasFiles: boolean | null;
};

export type InspectorOptions = {
  label: string;
  /** Scan the decompressed payload as a tar stream. */
  tar: boolean;
  /** Runs after the last byte, before the stream ends. A throw fails the archive. */
  beforeEnd?: (stats: ArchiveStats) => Promise<void>;
  /** Fail when no bytes arrive for this long. */
  stallMs?: number;
};

export const DEFAULT_STALL_MS = 10 * 60 * 1000;

const BLOCK = 512;
// Tar entry types that describe the next member rather than being one.
const META_TYPES = new Set(["L", "K", "x", "g"]);

/** Tracks tar headers across a byte stream. Stops parsing once a file member is found. */
export class TarMemberScanner {
  hasFiles = false;
  private pending = Buffer.alloc(0);
  private skip = 0;

  write(buf: Buffer) {
    if (this.hasFiles) return;
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, buf]) : buf;
    while (data.length > 0) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, data.length);
        this.skip -= n;
        data = data.subarray(n);
        continue;
      }
      if (data.length < BLOCK) break;
      const header = data.subarray(0, BLOCK);
      data = data.subarray(BLOCK);
      if (header.every((b) => b === 0)) continue;
      const type = String.fromCharCode(header[156] || 0x30);
      if (type !== "5" && !META_TYPES.has(type)) {
        this.hasFiles = true;
        return;
      }
      this.skip = Math.ceil(entrySize(header) / BLOCK) * BLOCK;
    }
    this.pending = Buffer.from(data);
  }
}

function entrySize(header: Buffer): number {
  const field = header.subarray(124, 136);
  // GNU base-256 for sizes past 8 GiB.
  if (field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  return text ? parseInt(text, 8) : 0;
}

/** Pass-through that checksums the gzip bytes and proves they decompress, without touching disk. */
export class ArchiveInspector extends Transform {
  private hash = createHash("sha256");
  private bytes = 0;
  private gunzip: Gunzip;
  private scanner: TarMemberScanner | null;
  private gunzipDone: Promise<void>;
  private stallTimer: NodeJS.Timeout | null = null;
  private readonly stallMs: number;

  constructor(private readonly opts: InspectorOptions) {
    super();
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.scanner = opts.tar ? new TarMemberScanner() : null;
    this.gunzip = createGunzip();
    this.gunzipDone = new Promise((resolve, reject) => {
      this.gunzip.on("end", resolve);
      this.gunzip.on("error", (err) =>
        reject(new Error(`${opts.label} archive is corrupt (gzip check failed: ${err.message})`)),
      );
    });
    // Fail now rather than wait on a drain that won't come.
    this.gunzipDone.catch((err) => this.destroy(err));
    this.gunzip.on("data", (chunk: Buffer) => this.scanner?.write(chunk));
    this.armStall();
  }

  private armStall() {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.destroy(new Error(`${this.opts.label} stalled: no data for ${Math.round(this.stallMs / 60_000)} minutes`));
    }, this.stallMs);
    this.stallTimer.unref?.();
  }

  private disarmStall() {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.armStall();
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (this.gunzip.write(chunk)) cb(null, chunk);
    else this.gunzip.once("drain", () => cb(null, chunk));
  }

  _flush(cb: TransformCallback) {
    this.disarmStall();
    this.gunzip.end();
    (async () => {
      if (this.bytes === 0) throw new Error(`${this.opts.label} archive is corrupt (gzip check failed: no data)`);
      await this.gunzipDone;
      const stats: ArchiveStats = {
        bytes: this.bytes,
        sha256: this.hash.digest("hex"),
        hasFiles: this.scanner ? this.scanner.hasFiles : null,
      };
      this.stats = stats;
      await this.opts.beforeEnd?.(stats);
    })().then(() => cb(), (err) => cb(err as Error));
  }

  _destroy(err: Error | null, cb: (error: Error | null) => void) {
    this.disarmStall();
    this.gunzip.destroy();
    cb(err);
  }

  /** Set once the stream has ended cleanly. */
  stats: ArchiveStats | null = null;
}

export function createArchiveInspector(opts: InspectorOptions): ArchiveInspector {
  return new ArchiveInspector(opts);
}
