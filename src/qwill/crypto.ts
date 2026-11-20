/**
 * Encryption boundary for QWill.
 *
 * The recovery instructions are the only sensitive payload in the system, and
 * they follow one rule: **plaintext never leaves the owner's device and never
 * touches the chain.**
 *
 *  - The owner encrypts the instructions to the beneficiary with QoreSeal
 *    (ML-KEM-1024, FIPS 203) — `@qorechain/qoreseal`, against the beneficiary's
 *    registered on-chain encryption key.
 *  - The resulting envelope (see `SealedEnvelope` in types.ts) is stored
 *    off-chain. It is useless to anyone but the beneficiary.
 *  - On-chain, a registration stores only `commitment`: the hash below over
 *    the envelope bytes. At claim time the app re-hashes the released
 *    envelope and compares it with the commitment, so a swapped or corrupted
 *    envelope cannot be passed off as the owner's instructions.
 *
 * TODO(Day 3): wire `sealInstructions` to `@qorechain/qoreseal` once the
 * beneficiary key-registry lookup is in place.
 */
import type { SealedEnvelope } from "./types";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Commitment over an envelope's ciphertext bytes (SHA-256, hex).
 * QoreChain's native hash is SHAKE-256; aligning this commitment with
 * `@qorechain/pqc`'s SHAKE-256 is a Day-2 task, recorded in the README
 * roadmap. The commitment scheme itself (hash of the exact envelope bytes)
 * does not change.
 */
export async function hashCommitment(ciphertext: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    ciphertext as unknown as BufferSource,
  );
  return toHex(new Uint8Array(digest));
}

/** Recomputes the commitment for a released envelope and compares it. */
export async function verifyCommitment(
  envelope: SealedEnvelope,
  commitment: string,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(envelope.ciphertext);
  return (await hashCommitment(bytes)) === commitment;
}
