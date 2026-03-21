import { generateKeyPairSync } from "crypto";
import { createPublicKey } from "crypto";

/**
 * Generate an Ed25519 SSH keypair for use as a deploy key.
 *
 * Returns:
 * - publicKey: OpenSSH format (ssh-ed25519 AAAA... host/key-name)
 * - privateKey: PEM format (suitable for GIT_SSH_COMMAND)
 */
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

  // Convert PEM public key to OpenSSH format
  const pubKeyObj = createPublicKey(publicKey);
  const sshPublicKey = pubKeyObj
    .export({ type: "spki", format: "der" })
    // Ed25519 DER SPKI is 44 bytes: 12-byte header + 32-byte key
    // OpenSSH format: "ssh-ed25519" + length-prefixed type + length-prefixed key
    ? formatOpenSSHEd25519(pubKeyObj, comment)
    : publicKey;

  return {
    publicKey: sshPublicKey,
    privateKey,
  };
}

/**
 * Convert a Node.js Ed25519 public key to OpenSSH wire format.
 * Format: ssh-ed25519 <base64-encoded-blob> <comment>
 */
function formatOpenSSHEd25519(
  pubKeyObj: ReturnType<typeof createPublicKey>,
  comment?: string
): string {
  const der = pubKeyObj.export({ type: "spki", format: "der" });

  // Ed25519 SPKI DER structure:
  // 30 2a (SEQUENCE, 42 bytes)
  //   30 05 (SEQUENCE, 5 bytes - algorithm identifier)
  //     06 03 2b 65 70 (OID 1.3.101.112 = Ed25519)
  //   03 21 00 (BIT STRING, 33 bytes, 0 unused bits)
  //     <32 bytes of public key>
  const rawKey = der.subarray(der.length - 32);

  // OpenSSH wire format: string "ssh-ed25519" + string <32-byte key>
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
