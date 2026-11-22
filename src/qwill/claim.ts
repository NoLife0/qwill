/**
 * The beneficiary claim flow.
 *
 * After the will lapses (see switch.ts — lapse is computed from the block
 * times of the owner's own check-in transactions, so anyone can verify it
 * in the explorer), the named beneficiary opens a claim:
 *
 *  1. `checkClaimable` re-derives the will from chain history and decides
 *     whether this claimant, at this chain time, may claim.
 *  2. The beneficiary sends a hybrid-signed claim anchor
 *     (`qwill:v1:claim:<willId>`) from their own session — their account
 *     needs its own registered ML-DSA-87 key and a little test QOR first.
 *  3. `releaseEnvelope` hands the sealed envelope over only when its
 *     commitment matches the one recorded at registration. The beneficiary
 *     then opens it with their ML-KEM-1024 secret key (see seal.ts).
 *
 * TESTNET ONLY. The beneficiary session here derives from the same project
 * mnemonic (account index 1) because this is the demo/test path; a real
 * beneficiary runs the same steps from their own wallet.
 */
import { anchorAction, openOwnerSession, type OwnerSession } from "./chain";
import { verifyCommitment } from "./crypto";
import { canClaim, deadlineOf, isLapsed } from "./switch";
import type { SealedEnvelope, WillRecord } from "./types";

/** Opens the beneficiary's signing session (account index 1 by default). */
export async function openClaimSession(
  mnemonic: string,
  accountIndex = 1,
): Promise<OwnerSession> {
  return openOwnerSession(mnemonic, accountIndex);
}

/** The claim decision for one claimant at one chain time. */
export function checkClaimable(
  will: WillRecord,
  claimant: string,
  nowSec: number,
): { lapsed: boolean; canClaim: boolean; deadline: number } {
  return {
    lapsed: isLapsed(will, nowSec),
    canClaim: canClaim(will, claimant, nowSec),
    deadline: deadlineOf(will),
  };
}

/**
 * Sends the beneficiary's hybrid-signed claim anchor. Callers must have
 * checked `checkClaimable` first — the chain accepts any memo, so the
 * validity of a claim lives in the projection (history.ts), not in the
 * transaction itself.
 */
export async function sendClaimAnchor(
  session: OwnerSession,
  willId: string,
): Promise<string> {
  return anchorAction(session, `qwill:v1:claim:${willId}`);
}

/**
 * The release step: the sealed envelope is handed to the claimant only
 * when its commitment matches the one recorded at registration. A swapped
 * or corrupted envelope is refused here, before any decryption is attempted.
 */
export async function releaseEnvelope(
  envelope: SealedEnvelope,
  commitment: string,
): Promise<SealedEnvelope> {
  if (!(await verifyCommitment(envelope, commitment))) {
    throw new Error(
      "envelope commitment mismatch — refusing release (envelope is not the registered one)",
    );
  }
  return envelope;
}
