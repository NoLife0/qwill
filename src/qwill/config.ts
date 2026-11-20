/**
 * QoreChain testnet constants for QWill.
 *
 * Every value here is taken from the official network reference and the fest
 * "Start here" page, and was verified against the live endpoints on
 * 2026-11-20 (the REST node_info call answers for chain `qorechain-diana`).
 * QWill is testnet-only: there is deliberately no mainnet preset in this file.
 */
export const TESTNET = {
  /** Cosmos chain id. */
  chainId: "qorechain-diana",
  /** EVM chain id (hex 0x2648). */
  evmChainId: 9800,
  /** Native REST (LCD) endpoint — chain reads go through here. */
  rest: "https://api-testnet.qore.host",
  /** Consensus RPC — used by the signing client. */
  rpc: "https://rpc-testnet.qore.host",
  /** EVM JSON-RPC endpoint. */
  evmRpc: "https://evm-testnet.qore.host",
  /** Public block explorer. */
  explorer: "https://explore.qore.network",
  /** Dashboard hosting the testnet faucet. */
  dashboard: "https://dashboard.qorechain.io",
} as const;

/** Base denomination of QOR (1 QOR = 10^6 uqor). */
export const BASE_DENOM = "uqor";

/**
 * Memo namespace for QWill transactions. Will registrations, check-ins and
 * claims are anchored on-chain as hybrid-signed transactions whose memo
 * carries `qwill:v1:<action>:<willId>`, so the full life of a will can be
 * rebuilt from the owner's transaction history alone.
 */
export const MEMO_PREFIX = "qwill:v1";

/** Default check-in interval offered in the UI: 30 days, in seconds. */
export const DEFAULT_CHECK_IN_INTERVAL_SEC = 30 * 24 * 60 * 60;
