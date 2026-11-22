/**
 * QWill data model.
 *
 * A will is the unit of the app. Its authoritative history lives on-chain:
 * the registration, every check-in and the claim are hybrid-signed testnet
 * transactions, and the timestamps used by the switch are the block times of
 * those transactions. This model is the projection the app builds from that
 * history (plus the off-chain envelope pointer).
 */

/** Lifecycle of a will. `lapsed` is derived from time, never stored blindly. */
export type WillStatus = "active" | "lapsed" | "claimed" | "revoked";

export interface WillRecord {
  /** Stable id: `qwill:<owner>:<nonce>` — also carried in transaction memos. */
  id: string;
  /** Owner (testator) native address, `qor1…`. */
  owner: string;
  /** Beneficiary native address, `qor1…`. */
  beneficiary: string;
  /** Seconds the owner may go without a check-in before the will lapses. */
  checkInIntervalSec: number;
  /** Block time (unix seconds) of the registration transaction. */
  createdAt: number;
  /** Block time (unix seconds) of the most recent check-in (or registration). */
  lastCheckInAt: number;
  /**
   * Hex hash commitment of the encrypted instructions envelope.
   * The envelope itself is QoreSeal-encrypted to the beneficiary and stored
   * off-chain; the chain only ever sees this commitment.
   */
  commitment: string;
  /** Pointer to the off-chain encrypted envelope (storage URI). */
  envelopeUri: string;
  /** Transaction hash of the hybrid-signed registration. */
  registrationTx: string;
  /** Stored terminal states; `active` vs `lapsed` is derived by the switch. */
  status: Exclude<WillStatus, "lapsed">;
}

/** One proof-of-life event: a hybrid-signed check-in transaction. */
export interface CheckInRecord {
  willId: string;
  owner: string;
  /** Block time (unix seconds) of the check-in transaction. */
  at: number;
  txHash: string;
}

/** The beneficiary's claim, opened after a verified lapse. */
export interface ClaimRecord {
  willId: string;
  beneficiary: string;
  /** Block time (unix seconds) of the claim transaction. */
  at: number;
  txHash: string;
}

/**
 * The off-chain encrypted instructions envelope (see seal.ts).
 * QoreSeal v1 construction: AES-256-GCM payload under a random data key,
 * the data key wrapped with an ML-KEM-1024 encapsulation to the recipient.
 * All byte fields are base64. The chain only ever sees the commitment
 * (SHA-256 over the canonical JSON of this object) — never the envelope.
 */
export interface SealedEnvelope {
  version: 1;
  /** Construction marker: `qoreseal-v1/mlkem1024+aes256gcm`. */
  construction: "qoreseal-v1/mlkem1024+aes256gcm";
  /** Chain the envelope is bound to (HKDF info), e.g. `qorechain-diana`. */
  chainId: string;
  /** Purpose the envelope is bound to, e.g. `qwill-recovery-v1`. */
  purpose: string;
  /** Beneficiary address the envelope is encrypted to. */
  recipient: string;
  /** ML-KEM-1024 encapsulation ciphertext, base64 (1568 bytes). */
  kemCiphertext: string;
  /** AES-GCM nonce for the wrapped data key, base64 (12 bytes). */
  wrapNonce: string;
  /** Wrapped 32-byte data key (AES-256-GCM), base64. */
  wrappedKey: string;
  /** AES-GCM nonce for the payload, base64 (12 bytes). */
  nonce: string;
  /** Encrypted recovery instructions (AES-256-GCM), base64. */
  ciphertext: string;
}
