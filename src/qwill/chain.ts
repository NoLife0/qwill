/**
 * Chain bootstrap for QWill: QoreChain testnet client, account derivation and
 * hybrid signing, built on `@qorechain/sdk`.
 *
 * The signing flow follows the official SDK quickstart exactly:
 *  1. Derive the native account from a mnemonic.
 *  2. Derive the address-bound ML-DSA-87 keypair (`derivePqcCanonical`).
 *  3. Register that post-quantum key on-chain once (`ensurePqcRegistered`) —
 *     the one transaction the chain accepts with a classical-only signature.
 *  4. From then on, every transaction the client sends (registration,
 *     check-ins, claims) is signed hybrid: secp256k1 + ML-DSA-87.
 *
 * TESTNET ONLY. The mnemonic belongs to a fresh project account created for
 * this fest entry; it is read from the environment and never committed.
 */
import {
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  ensurePqcRegistered,
  type QoreChainClient,
} from "@qorechain/sdk";

import { BASE_DENOM, TESTNET } from "./config";

/** A read/write client pinned to the public testnet endpoints. */
export function qwillClient(): QoreChainClient {
  return createClient({
    endpoints: { rest: TESTNET.rest, rpc: TESTNET.rpc },
  });
}

/** An owner session: account + hybrid-capable transaction client. */
export interface OwnerSession {
  client: QoreChainClient;
  /** Native `qor1…` address of the account. */
  address: string;
  /** Transaction client that signs hybrid when given the PQC keypair. */
  tx: Awaited<ReturnType<QoreChainClient["connectTx"]>>;
  /** Address-bound ML-DSA-87 keypair for this account. */
  pqcKeypair: ReturnType<typeof derivePqcCanonical>;
}

/**
 * Opens a session for the account behind `mnemonic`. Does not broadcast
 * anything; call `ensureHybridReady` before the first transaction.
 */
export async function openOwnerSession(
  mnemonic: string,
): Promise<OwnerSession> {
  const client = qwillClient();
  const account = await deriveNativeAccount(mnemonic);
  const signer = await directSignerFromPrivateKey(account.privateKey, "qor");
  const pqcKeypair = derivePqcCanonical(account.address, mnemonic);
  const tx = await client.connectTx(signer, { pqcKeypair });
  return { client, address: account.address, tx, pqcKeypair };
}

/**
 * Registers the account's ML-DSA-87 key on-chain if needed (idempotent: the
 * SDK helper reads the key status over REST first and skips the transaction
 * when the key is already registered). The registration fee follows the
 * quickstart: 60,000 uqor against a 600,000 gas limit for the 2,592-byte key.
 *
 * The account must hold test QOR first — get it from the Dashboard faucet.
 */
export async function ensureHybridReady(
  session: OwnerSession,
): Promise<{ alreadyRegistered: boolean; txHash?: string }> {
  const res = await ensurePqcRegistered(session.tx, {
    pqcKeypair: session.pqcKeypair,
    rest: TESTNET.rest,
    fee: { amount: [{ denom: BASE_DENOM, amount: "60000" }], gas: "600000" },
  });
  return res.alreadyRegistered
    ? { alreadyRegistered: true }
    : { alreadyRegistered: false, txHash: res.txHash };
}

/**
 * Sends a hybrid-signed self-transfer carrying a QWill memo — the anchoring
 * primitive for registrations, check-ins and claims. The transferred amount
 * is a nominal 1 uqor to the owner's own address; the payload is the memo
 * (`qwill:v1:<action>:<willId>`, see config.ts) and the block time the chain
 * stamps on the transaction.
 *
 * TODO(Day 2): run against the funded project account, record the first
 * registration + check-in hashes in the README, and read the will projection
 * back from the account's transaction history.
 */
export async function anchorAction(
  session: OwnerSession,
  memo: string,
): Promise<string> {
  const result = await session.tx.bankSend(
    session.address,
    [{ denom: BASE_DENOM, amount: "1" }],
    { memo },
  );
  return result.transactionHash;
}
