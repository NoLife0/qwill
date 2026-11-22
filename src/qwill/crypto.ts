/**
 * Encryption boundary for QWill.
 *
 * The recovery instructions are the only sensitive payload in the system, and
 * they follow one rule: **plaintext never leaves the owner's device and never
 * touches the chain.**
 *
 *  - The owner encrypts the instructions to the beneficiary with the
 *    QoreSeal v1 construction (ML-KEM-1024 + AES-256-GCM, see `seal.ts`),
 *    against the beneficiary's ML-KEM key published on-chain.
 *  - The resulting envelope is stored off-chain. It is useless to anyone
 *    but the beneficiary.
 *  - On-chain, a registration stores only `commitment`: the hash below over
 *    the canonical JSON of the exact envelope bytes. At claim time the app
 *    re-hashes the released envelope and compares it with the commitment,
 *    so a swapped or corrupted envelope cannot be passed off as the
 *    owner's instructions.
 *
 * Day-3 note: the commitment is SHA-256 over the canonical (sorted-key)
 * JSON of the full envelope. Aligning it with `@qorechain/pqc`'s SHAKE-256
 * remains future work; the scheme itself (hash of the exact envelope bytes)
 * does not change.
 */
import type { SealedEnvelope } from "./types";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical JSON of a value: object keys sorted recursively, so the same
 * envelope always hashes to the same commitment on any device.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Commitment over an envelope's exact bytes: SHA-256 (hex) of its canonical
 * JSON. Any change to any field — ciphertext, KEM blob, chain, purpose —
 * changes the commitment.
 */
export async function hashCommitment(ciphertext: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    ciphertext as unknown as BufferSource,
  );
  return toHex(new Uint8Array(digest));
}

/** Commitment for a whole envelope (canonical JSON → SHA-256). */
export async function envelopeCommitment(
  envelope: SealedEnvelope,
): Promise<string> {
  return hashCommitment(new TextEncoder().encode(canonicalJson(envelope)));
}

/** Recomputes the commitment for a released envelope and compares it. */
export async function verifyCommitment(
  envelope: SealedEnvelope,
  commitment: string,
): Promise<boolean> {
  return (await envelopeCommitment(envelope)) === commitment;
}
