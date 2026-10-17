// Signed records: Ed25519 over the exact payload bytes. See FORMAT.md.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { Bucket, CheckResult, WatchEntry } from "./types";

export const RECORD_VERSION = 1;
const DOMAIN = "vardo-uptime/v1\n";

export type ResultBatch = {
  v: typeof RECORD_VERSION;
  kind: "results";
  vantageId: string;
  issuedAt: number;
  results: CheckResult[];
};

export type HourlySummary = {
  v: typeof RECORD_VERSION;
  kind: "hourly";
  vantageId: string;
  issuedAt: number;
  monitorId: string;
  bucket: Bucket;
};

/** The monitors an instance asks a vantage point to check. */
export type WatchList = {
  v: typeof RECORD_VERSION;
  kind: "watch";
  vantageId: string;
  issuedAt: number;
  monitors: WatchEntry[];
};

export type RecordPayload = ResultBatch | HourlySummary | WatchList;

/** The wire form: the payload as JSON text, and the signature over that text. */
export type SignedRecord = {
  payload: string;
  /** Base64 Ed25519 signature. */
  sig: string;
};

export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function resultBatch(vantageId: string, results: CheckResult[], issuedAt: number): ResultBatch {
  return { v: RECORD_VERSION, kind: "results", vantageId, issuedAt, results };
}

export function hourlySummary(vantageId: string, monitorId: string, bucket: Bucket, issuedAt: number): HourlySummary {
  return { v: RECORD_VERSION, kind: "hourly", vantageId, issuedAt, monitorId, bucket };
}

export function watchList(vantageId: string, monitors: WatchEntry[], issuedAt: number): WatchList {
  return { v: RECORD_VERSION, kind: "watch", vantageId, issuedAt, monitors };
}

export function signRecord(payload: RecordPayload, privateKeyPem: string): SignedRecord {
  const text = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(DOMAIN + text), createPrivateKey(privateKeyPem));
  return { payload: text, sig: sig.toString("base64") };
}

/** The payload when the signature holds for this key and the version is known, else null. */
export function verifyRecord(record: SignedRecord, publicKeyPem: string): RecordPayload | null {
  try {
    const ok = verify(null, Buffer.from(DOMAIN + record.payload), createPublicKey(publicKeyPem), Buffer.from(record.sig, "base64"));
    if (!ok) return null;
    const parsed = JSON.parse(record.payload) as RecordPayload;
    if (parsed.v !== RECORD_VERSION || (parsed.kind !== "results" && parsed.kind !== "hourly" && parsed.kind !== "watch")) return null;
    return parsed;
  } catch {
    return null;
  }
}
