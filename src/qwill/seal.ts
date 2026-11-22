/**
 * QoreSeal envelope for QWill — ML-KEM-1024 (FIPS 203) + AES-256-GCM.
 *
 * This implements the QoreSeal v1 construction as published by QoreChain
 * (README + spec of `qorechain/qoreseal`): the payload is encrypted once
 * with a random AES-256-GCM data key, and that data key is wrapped for the
 * recipient with an ML-KEM-1024 encapsulation to the recipient's key. Keys
 * are derived with HKDF-SHA-256 bound to chain + purpose
 * (`"qorechain-kem-v1|" + chainId + "|" + purpose`), so an envelope sealed
 * for one chain or purpose cannot be opened under another.
 *
 * The primitives come from `@qorechain/pqc` (already a dependency of
 * `@qorechain/sdk`): `mlkem1024.keygen / encapsulate / decapsulate`.
 * The recipient's encapsulation key is the one they published on-chain
 * (`MsgRegisterKEMKey`, read back with `fetchKemKey`).
 *
 * NOTE on the `@qorechain/qoreseal` package: its TypeScript package was not
 * installed in this repo — the npm tarball download for it was flagged by an
 * execution-risk check during the Day-3 run, so installing it needs the
 * user's explicit go-ahead. This file is therefore NOT claimed to be
 * byte-compatible with that package's envelopes; it is the same construction
 * (same primitives, same HKDF binding, same shape) built on the SDK's own
 * PQC library. Swapping in the official package later means replacing
 * `sealInstructions` / `openEnvelope` bodies, not the call sites.
 */
import { mlkem1024 } from "@qorechain/pqc";

import type { SealedEnvelope } from "./types";

/** Purpose string this app seals under; part of the HKDF binding. */
export const SEAL_PURPOSE = "qwill-recovery-v1";

/** HKDF info prefix from the QoreSeal v1 construction. */
export const SEAL_INFO_PREFIX = "qorechain-kem-v1";

/** ML-KEM-1024 public-key size in bytes (FIPS 203). */
export const ML_KEM_1024_PUBLIC_KEY_BYTES = 1568;

/** A beneficiary's ML-KEM-1024 keypair (the seal keys). */
export interface SealKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generates a fresh ML-KEM-1024 keypair for a beneficiary. */
export function generateSealKeys(): SealKeypair {
  return mlkem1024.keygen();
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function aesGcm(
  key: CryptoKey,
  data: Uint8Array,
  nonce: Uint8Array,
  decrypt: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const op = decrypt ? crypto.subtle.decrypt : crypto.subtle.encrypt;
  const out = await op.call(
    crypto.subtle,
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    key,
    data as unknown as BufferSource,
  );
  return new Uint8Array(out);
}

/**
 * Derives the key-wrapping key from an ML-KEM shared secret, bound to the
 * chain and purpose so the wrap only opens in the right context.
 */
async function deriveWrapKey(
  sharedSecret: Uint8Array,
  chainId: string,
  purpose: string,
): Promise<CryptoKey> {
  const info = new TextEncoder().encode(
    `${SEAL_INFO_PREFIX}|${chainId}|${purpose}|wrap`,
  );
  const base = await crypto.subtle.importKey(
    "raw",
    sharedSecret as unknown as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: info as unknown as BufferSource,
    },
    base,
    256,
  );
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seals recovery instructions to a beneficiary's ML-KEM-1024 public key.
 * The plaintext never leaves the caller's device except inside this
 * envelope; only the recipient's secret key can open it.
 */
export async function sealInstructions(opts: {
  chainId: string;
  purpose: string;
  recipient: string;
  recipientPublicKey: Uint8Array;
  plaintext: Uint8Array | string;
}): Promise<SealedEnvelope> {
  const { chainId, purpose, recipient, recipientPublicKey } = opts;
  if (recipientPublicKey.length !== ML_KEM_1024_PUBLIC_KEY_BYTES) {
    throw new Error(
      `recipient ML-KEM-1024 public key must be ${ML_KEM_1024_PUBLIC_KEY_BYTES} bytes, got ${recipientPublicKey.length}`,
    );
  }
  const plaintext =
    typeof opts.plaintext === "string"
      ? new TextEncoder().encode(opts.plaintext)
      : opts.plaintext;

  // Random data key encrypts the payload; the data key itself is wrapped
  // for the recipient with an ML-KEM-1024 encapsulation.
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const { cipherText: kemCiphertext, sharedSecret } =
    mlkem1024.encapsulate(recipientPublicKey);
  const wrapKey = await deriveWrapKey(sharedSecret, chainId, purpose);
  const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await aesGcm(wrapKey, dataKey, wrapNonce, false);

  const aesKey = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, [
    "encrypt",
  ]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await aesGcm(aesKey, plaintext, nonce, false);

  return {
    version: 1,
    construction: "qoreseal-v1/mlkem1024+aes256gcm",
    chainId,
    purpose,
    recipient,
    kemCiphertext: b64encode(kemCiphertext),
    wrapNonce: b64encode(wrapNonce),
    wrappedKey: b64encode(wrappedKey),
    nonce: b64encode(nonce),
    ciphertext: b64encode(ciphertext),
  };
}

/**
 * Opens a sealed envelope with the recipient's ML-KEM-1024 secret key.
 * Throws when the envelope is bound to another chain/purpose, the key is
 * wrong, or any byte was tampered with (AES-GCM authentication fails).
 */
export async function openEnvelope(opts: {
  chainId: string;
  purpose: string;
  envelope: SealedEnvelope;
  secretKey: Uint8Array;
}): Promise<Uint8Array> {
  const { chainId, purpose, envelope, secretKey } = opts;
  if (envelope.chainId !== chainId || envelope.purpose !== purpose) {
    throw new Error(
      `envelope is bound to ${envelope.chainId}/${envelope.purpose}, not ${chainId}/${purpose}`,
    );
  }
  const sharedSecret = mlkem1024.decapsulate(
    secretKey,
    b64decode(envelope.kemCiphertext),
  );
  const wrapKey = await deriveWrapKey(sharedSecret, chainId, purpose);
  const dataKey = await aesGcm(
    wrapKey,
    b64decode(envelope.wrappedKey),
    b64decode(envelope.wrapNonce),
    true,
  );
  const aesKey = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, [
    "decrypt",
  ]);
  return aesGcm(
    aesKey,
    b64decode(envelope.ciphertext),
    b64decode(envelope.nonce),
    true,
  );
}
