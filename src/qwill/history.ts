/**
 * Tx-history projection reader for QWill.
 *
 * Rebuilds a will's life from the owner's on-chain transaction history
 * alone: every registration, check-in and claim is a hybrid-signed
 * self-transfer whose memo carries `qwill:v1:<action>:<willId>`, and the
 * block time stamped on each transaction is the clock the dead-man's switch
 * runs on (see switch.ts). Reads go through the public testnet REST
 * endpoint — no signer, no mnemonic, no funds needed.
 */
import { MEMO_PREFIX, TESTNET } from "./config";
import { applyCheckIn, deadlineOf, statusAt } from "./switch";
import type { CheckInRecord, ClaimRecord, WillRecord, WillStatus } from "./types";

/** One QWill-anchored transaction found in an account's history. */
export interface AnchoredTx {
  hash: string;
  height: string;
  /** Block time, unix seconds. */
  atSec: number;
  action: "register" | "checkin" | "claim";
  willId: string;
  memo: string;
}

const MEMO_RE = new RegExp(`^${MEMO_PREFIX}:(register|checkin|claim):(.+)$`);

/** Parses a memo into its action + will id, or null when it is not a QWill anchor. */
export function parseAnchorMemo(memo: string): { action: AnchoredTx["action"]; willId: string } | null {
  const m = MEMO_RE.exec(memo.trim());
  if (!m) return null;
  return { action: m[1] as AnchoredTx["action"], willId: m[2] };
}

/**
 * Lists every QWill-anchored transaction sent by `address`, newest first.
 *
 * Two hops, because the public REST node's tx-search endpoint
 * (`/cosmos/tx/v1beta1/txs?events=…`) answers every query — valid or not —
 * with HTTP 500 `{"code":13,"message":"query cannot be empty"}` (verified
 * 2026-11-22; it is broken on this node, not our encoding):
 *   1. CometBFT RPC `tx_search` (`message.sender='<address>'`) lists the
 *      sender's transaction hashes.
 *   2. Each hash is read back over REST (`/cosmos/tx/v1beta1/txs/{hash}`),
 *      which does work and returns the memo + block timestamp.
 * Only successful transactions whose memo matches the QWill namespace are
 * kept. Reads need no signer, mnemonic or funds.
 */
export async function listAnchoredTxs(
  address: string,
  restBase: string = TESTNET.rest,
  rpcBase: string = TESTNET.rpc,
): Promise<AnchoredTx[]> {
  // 1. Hashes from RPC tx_search (paginated).
  const hashes: { hash: string; height: string }[] = [];
  let page = 1;
  let returned = 0;
  for (;;) {
    const params = new URLSearchParams({
      // CometBFT wants the whole query double-quoted:
      // query="message.sender='qor1…'" — without the quotes it 500s.
      // Every param value is parsed as JSON by the RPC, so order_by must
      // be the quoted string "asc" too (bare asc → "invalid character 'a'").
      query: `"message.sender='${address}'"`,
      prove: "false",
      page: String(page),
      per_page: "100",
      order_by: '"asc"',
    });
    const res = await fetch(`${rpcBase}/tx_search?${params}`);
    if (!res.ok) throw new Error(`tx search failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: {
        txs?: Array<{ hash: string; height: string; tx_result?: { code?: number } }>;
        total_count?: string;
      };
      error?: { message?: string };
    };
    if (json.error) {
      throw new Error(`tx search failed: ${json.error.message ?? "unknown RPC error"}`);
    }
    const txs = json.result?.txs ?? [];
    returned += txs.length;
    for (const t of txs) {
      if ((t.tx_result?.code ?? 0) !== 0) continue;
      hashes.push({ hash: t.hash, height: t.height });
    }
    const total = Number(json.result?.total_count ?? returned);
    if (txs.length === 0 || returned >= total) break;
    page++;
    if (page > 20) break;
  }

  // 2. Memo + block time per hash over REST.
  const found: AnchoredTx[] = [];
  for (const { hash, height } of hashes) {
    const res = await fetch(`${restBase}/cosmos/tx/v1beta1/txs/${hash}`);
    if (!res.ok) continue;
    const json = (await res.json()) as {
      tx?: { body?: { memo?: string } };
      tx_response?: { height?: string; timestamp?: string; code?: number };
    };
    const txr = json.tx_response;
    if (!txr || txr.code !== 0 || !txr.timestamp) continue;
    const memo = json.tx?.body?.memo ?? "";
    const parsed = parseAnchorMemo(memo);
    if (!parsed) continue;
    found.push({
      hash,
      height: txr.height ?? height,
      atSec: Math.floor(Date.parse(txr.timestamp) / 1000),
      action: parsed.action,
      willId: parsed.willId,
      memo,
    });
  }
  return found.sort((a, b) => b.atSec - a.atSec);
}

/**
 * Rebuilds the projection of one will from its anchored transactions.
 * Needs the off-chain facts the chain never sees (beneficiary, interval,
 * commitment, envelope URI) — pass them in; everything time-based comes
 * from the chain. Returns null when no registration anchor exists.
 *
 * Events are replayed in block-time order. A claim anchor only counts when
 * its block time is past the deadline at that moment — a premature claim
 * (sent before any lapse) is ignored, and once a valid claim lands the
 * will is terminal: later check-ins are ignored.
 */
export function projectWillFromHistory(
  anchored: AnchoredTx[],
  facts: {
    willId: string;
    owner: string;
    beneficiary: string;
    checkInIntervalSec: number;
    commitment: string;
    envelopeUri: string;
  },
  nowSec: number,
): {
  will: WillRecord;
  checkIns: CheckInRecord[];
  claim?: ClaimRecord;
  status: WillStatus;
} | null {
  const mine = anchored
    .filter((t) => t.willId === facts.willId)
    .sort((a, b) => a.atSec - b.atSec);
  const registration = mine.find((t) => t.action === "register");
  if (!registration) return null;
  const checkIns: CheckInRecord[] = mine
    .filter((t) => t.action === "checkin")
    .map((t) => ({ willId: facts.willId, owner: facts.owner, at: t.atSec, txHash: t.hash }));
  let will: WillRecord = {
    id: facts.willId,
    owner: facts.owner,
    beneficiary: facts.beneficiary,
    checkInIntervalSec: facts.checkInIntervalSec,
    createdAt: registration.atSec,
    lastCheckInAt: registration.atSec,
    commitment: facts.commitment,
    envelopeUri: facts.envelopeUri,
    registrationTx: registration.hash,
    status: "active",
  };
  let claim: ClaimRecord | undefined;
  for (const tx of mine) {
    if (tx.action === "checkin") {
      will = applyCheckIn(will, tx.atSec);
    } else if (
      tx.action === "claim" &&
      will.status === "active" &&
      tx.atSec > deadlineOf(will)
    ) {
      will = { ...will, status: "claimed" };
      claim = {
        willId: facts.willId,
        beneficiary: facts.beneficiary,
        at: tx.atSec,
        txHash: tx.hash,
      };
    }
  }
  return { will, checkIns, claim, status: statusAt(will, nowSec) };
}
