/**
 * The dead-man's switch: pure lapse and claim logic.
 *
 * These functions are the original feature of QWill. They take the will
 * projection (types.ts) plus a point in time and decide the will's state.
 * All timestamps are unix seconds taken from block times, so a decision made
 * here can be re-made by anyone from the explorer alone.
 *
 * Rules:
 *  - A will lapses when `now > lastCheckInAt + checkInIntervalSec`.
 *  - Only the named beneficiary may claim, and only after a lapse.
 *  - Claimed and revoked are terminal: the switch never flips them back.
 */
import type { WillRecord, WillStatus } from "./types";

/** The moment (unix seconds) at which the will lapses without a check-in. */
export function deadlineOf(will: WillRecord): number {
  return will.lastCheckInAt + will.checkInIntervalSec;
}

/** True when an active will has passed its deadline at `nowSec`. */
export function isLapsed(will: WillRecord, nowSec: number): boolean {
  return will.status === "active" && nowSec > deadlineOf(will);
}

/** The will's status at `nowSec`, with `lapsed` derived from time. */
export function statusAt(will: WillRecord, nowSec: number): WillStatus {
  if (will.status !== "active") return will.status;
  return isLapsed(will, nowSec) ? "lapsed" : "active";
}

/** Seconds of proof-of-life margin left; negative once lapsed. */
export function timeLeftSec(will: WillRecord, nowSec: number): number {
  return deadlineOf(will) - nowSec;
}

/**
 * Whether `claimant` may open a claim at `nowSec`: they must be the named
 * beneficiary and the will must have lapsed.
 */
export function canClaim(
  will: WillRecord,
  claimant: string,
  nowSec: number,
): boolean {
  return claimant === will.beneficiary && isLapsed(will, nowSec);
}

/**
 * Applies a check-in to the projection: a fresh proof of life moves
 * `lastCheckInAt` forward and therefore pushes the deadline out by the
 * will's interval. Check-ins against a terminal will are ignored.
 */
export function applyCheckIn(will: WillRecord, atSec: number): WillRecord {
  if (will.status !== "active") return will;
  if (atSec <= will.lastCheckInAt) return will;
  return { ...will, lastCheckInAt: atSec };
}
