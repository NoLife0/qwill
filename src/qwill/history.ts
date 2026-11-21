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
import { applyCheckIn, statusAt } from "./switch";
import type { CheckInRecord, WillRecord, WillStatus } from "./types";

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

interface RestTxPage {
  tx_responses?: Array<{
    txhash: string;
    height: string;
    timestamp: string;
    code: number;
  }>;
  txs?: Array<{ body?: { memo?: string } }>;
  pagination?: { next_key?: string | null };
}

/** Parses a memo into its action + will id, or null when it is not a QWill anchor. */
export function parseAnchorMemo(memo: string): { action: AnchoredTx["action"]; willId: string } | null {
  const m = MEMO_RE.exec(memo.trim());
  if (!m) return null;
  return { action: m[1] as AnchoredTx["action"], willId: m[2] };
}

/**
 * Lists every QWill-anchored transaction sent by `address`, newest first.
 * Pages through the REST tx search (`message.sender` event) and keeps only
 * successful transactions whose memo matches the QWill namespace.
 */
export async function listAnchoredTxs(
  address: string,
  restBase: string = TESTNET.rest,
): Promise<AnchoredTx[]> {
  const found: AnchoredTx[] = [];
  let nextKey: string | null = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      "events": `message.sender='${address}'`,
      "pagination.limit": "100",
    });
    if (nextKey) params.set("pagination.key", nextKey);
    const res = await fetch(`${restBase}/cosmos/tx/v1beta1/txs?${params}`);
    if (!res.ok) throw new Error(`tx history query failed: HTTP ${res.status}`);
    const json = (await res.json()) as RestTxPage;
    const responses = json.tx_responses ?? [];
    const bodies = json.txs ?? [];
    responses.forEach((txr, i) => {
      if (txr.code !== 0) return;
      const memo = bodies[i]?.body?.memo ?? "";
      const parsed = parseAnchorMemo(memo);
      if (!parsed) return;
      found.push({
        hash: txr.txhash,
        height: txr.height,
        atSec: Math.floor(Date.parse(txr.timestamp) / 1000),
        action: parsed.action,
        willId: parsed.willId,
        memo,
      });
    });
    nextKey = json.pagination?.next_key ?? null;
    if (!nextKey) break;
  }
  return found.sort((a, b) => b.atSec - a.atSec);
}

/**
 * Rebuilds the projection of one will from its anchored transactions.
 * Needs the off-chain facts the chain never sees (beneficiary, interval,
 * commitment, envelope URI) — pass them in; everything time-based comes
 * from the chain. Returns null when no registration anchor exists.
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
): { will: WillRecord; checkIns: CheckInRecord[]; status: WillStatus } | null {
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
  for (const c of checkIns) will = applyCheckIn(will, c.at);
  return { will, checkIns, status: statusAt(will, nowSec) };
}
