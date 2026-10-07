import { generateKeyPairSync } from "crypto";
import { createPublicKey } from "crypto";

/** Generates an Ed25519 deploy keypair: OpenSSH public key and PEM private key. */
export function generateDeployKeypair(comment?: string): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  const pubKeyObj = createPublicKey(publicKey);
  const sshPublicKey = pubKeyObj
    .export({ type: "spki", format: "der" })
    // Ed25519 DER SPKI is 44 bytes: 12-byte header + 32-byte key.
    ? formatOpenSSHEd25519(pubKeyObj, comment)
    : publicKey;

  return {
    publicKey: sshPublicKey,
    privateKey,
  };
}

/** Converts an Ed25519 public key to `ssh-ed25519 <base64> <comment>`. */
function formatOpenSSHEd25519(
  pubKeyObj: ReturnType<typeof createPublicKey>,
  comment?: string
): string {
  const der = pubKeyObj.export({ type: "spki", format: "der" });

  // The raw key is the last 32 bytes of the SPKI DER.
  const rawKey = der.subarray(der.length - 32);

  const typeStr = "ssh-ed25519";
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(typeStr.length);

  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(rawKey.length);

  const blob = Buffer.concat([
    typeLen,
    Buffer.from(typeStr),
    keyLen,
    rawKey,
  ]);

  const parts = [`ssh-ed25519`, blob.toString("base64")];
  if (comment) parts.push(comment);

  return parts.join(" ");
}
