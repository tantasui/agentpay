import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";

/**
 * Loads the payer's key from SOLANA_PRIVATE_KEY: either a JSON byte array (the
 * Solana CLI keypair file format) or a base58 string (the wallet export format).
 * The error never echoes the key.
 */
export async function loadSolanaSigner(secret: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  try {
    const trimmed = secret.trim();
    bytes = trimmed.startsWith("[")
      ? new Uint8Array(JSON.parse(trimmed) as number[])
      : new Uint8Array(getBase58Encoder().encode(trimmed));
  } catch {
    throw new Error("SOLANA_PRIVATE_KEY is neither a JSON byte array nor base58");
  }
  if (bytes.length !== 64) throw new Error(`SOLANA_PRIVATE_KEY must be 64 bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}
