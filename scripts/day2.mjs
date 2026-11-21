/**
 * QWill Day-2 runner — first hybrid-signed transactions on testnet.
 *
 * Flow (idempotent; safe to re-run — completed steps are recorded in the
 * state file and skipped):
 *   1. Load the project testnet mnemonic from QWILL_MNEMONIC_FILE
 *      (default: `../.qwill-testnet-mnemonic`, i.e. the project folder, OUTSIDE
 *      the git repo), or generate a fresh one and store it there with mode 600.
 *      The mnemonic is NEVER printed or logged.
 *   2. Derive the native account (index 0 = owner) and a beneficiary address
 *      (index 1, same mnemonic, no extra secret to manage).
 *   3. Fund the owner: try the SDK `requestFaucet` when QWILL_FAUCET_URL is
 *      set; otherwise wait for the Dashboard faucet (dashboard.qorechain.io)
 *      to be claimed for the printed address, polling the balance.
 *   4. `ensurePqcRegistered` — register the ML-DSA-87 key on-chain.
 *   5. Send the first hybrid-signed anchors:
 *      `qwill:v1:register:<willId>` and `qwill:v1:checkin:<willId>`.
 *   6. Verify each transaction over REST (code 0, height, block time) and
 *      print its explorer URL.
 *
 * TESTNET ONLY (`qorechain-diana`). Usage:
 *   node scripts/day2.mjs [--will qwill-demo-001] [--wait-min 10]
 *   QWILL_FAUCET_URL=https://… node scripts/day2.mjs   # SDK faucet attempt
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sdk = require("@qorechain/sdk");
const {
  generateMnemonic,
  validateMnemonic,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  createClient,
  ensurePqcRegistered,
  requestFaucet,
  explorerTxUrl,
  explorerAddressUrl,
} = sdk;

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EXPLORER = { explorerUrl: "https://explore.qore.network" };
const BASE_DENOM = "uqor";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Project folder = parent of the repo checkout (~/workspace/qorechain-qwill),
// NOT the repo itself: secrets must never live inside the git tree.
const PROJECT_DIR = resolve(SCRIPT_DIR, "..", "..");
const MNEMONIC_FILE =
  process.env.QWILL_MNEMONIC_FILE || resolve(PROJECT_DIR, ".qwill-testnet-mnemonic");
const STATE_FILE =
  process.env.QWILL_DAY2_STATE_FILE || resolve(PROJECT_DIR, ".qwill-day2-state.json");

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WILL_ID = argVal("--will", "qwill-demo-001");
const WAIT_MIN = Number(argVal("--wait-min", "10"));
const FAUCET_URL = process.env.QWILL_FAUCET_URL || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

async function getBalance(address) {
  const res = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`);
  const json = await res.json();
  const coin = (json.balances || []).find((c) => c.denom === BASE_DENOM);
  return BigInt(coin ? coin.amount : "0");
}

async function waitForTx(hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.ok) {
      const json = await res.json();
      const txr = json.tx_response;
      if (txr) return txr;
    }
    if (Date.now() > deadline) throw new Error(`tx ${hash} not indexed within timeout`);
    await sleep(3000);
  }
}

async function main() {
  // --- 1. Mnemonic: load or generate (never printed) ---
  let mnemonic;
  let fresh = false;
  if (existsSync(MNEMONIC_FILE)) {
    mnemonic = readFileSync(MNEMONIC_FILE, "utf8").trim();
    if (!validateMnemonic(mnemonic)) throw new Error("stored mnemonic fails validation");
    console.log(`Mnemonic: loaded from ${MNEMONIC_FILE} (mode 600, never printed)`);
  } else {
    mnemonic = generateMnemonic();
    writeFileSync(MNEMONIC_FILE, mnemonic + "\n", { mode: 0o600 });
    chmodSync(MNEMONIC_FILE, 0o600);
    fresh = true;
    console.log(`Mnemonic: GENERATED fresh 24-word phrase, stored at ${MNEMONIC_FILE} (mode 600)`);
    console.log("Mnemonic: (not printed — it lives only in that file)");
  }

  // --- 2. Derive owner + beneficiary ---
  const owner = await deriveNativeAccount(mnemonic);
  const beneficiary = await deriveNativeAccount(mnemonic, { accountIndex: 1 });
  console.log(`Owner (testnet):      ${owner.address}`);
  console.log(`Beneficiary (testnet): ${beneficiary.address}`);
  console.log(`Explorer (owner):      ${explorerAddressUrl(EXPLORER, owner.address)}`);

  const state = loadState();
  state.address = owner.address;
  state.beneficiary = beneficiary.address;
  state.willId = WILL_ID;
  state.mnemonicFile = MNEMONIC_FILE;
  state.freshAccount = fresh || state.freshAccount === true;
  saveState(state);

  // --- 3. Funding ---
  // Registration fee 60,000 uqor + two hybrid bank sends (~26k uqor each at
  // 0.15 uqor/gas) — require 200,000 uqor (0.2 QOR) before proceeding.
  const NEED = 200_000n;
  let balance = await getBalance(owner.address);
  console.log(`Balance: ${balance} uqor (${Number(balance) / 1e6} QOR)`);
  if (balance < NEED) {
    if (FAUCET_URL) {
      console.log(`Faucet: requesting via SDK requestFaucet (${FAUCET_URL}) …`);
      const result = await requestFaucet({ faucetUrl: FAUCET_URL }, owner.address);
      console.log(`Faucet: response ${JSON.stringify(result)}`);
    } else {
      console.log(
        "Faucet: no QWILL_FAUCET_URL set — the SDK has no built-in faucet URL\n" +
          "  and the Dashboard faucet needs a signed-in browser session.\n" +
          `  Claim 100 test QOR for ${owner.address} at https://dashboard.qorechain.io/faucet\n` +
          "  then re-run this script; it resumes from funding.",
      );
    }
    const deadline = Date.now() + WAIT_MIN * 60_000;
    while (balance < NEED) {
      if (Date.now() > deadline) {
        console.log(`FUNDING_REQUIRED: balance ${balance} uqor < ${NEED} uqor after ${WAIT_MIN} min`);
        console.log(`  Fund ${owner.address} via the Dashboard faucet, then re-run.`);
        process.exit(2);
      }
      await sleep(15_000);
      balance = await getBalance(owner.address);
      console.log(`Balance: ${balance} uqor (waiting for funding…)`);
    }
  }
  console.log(`Funding OK: ${balance} uqor`);

  // --- 4. Session + PQC key registration ---
  const client = createClient({ endpoints: { rest: REST, rpc: RPC } });
  const signer = await directSignerFromPrivateKey(owner.privateKey, "qor");
  const pqcKeypair = derivePqcCanonical(owner.address, mnemonic);
  const tx = await client.connectTx(signer, { pqcKeypair });

  if (!state.pqcRegistrationTx) {
    console.log("PQC: registering ML-DSA-87 key on-chain (ensurePqcRegistered) …");
    const res = await ensurePqcRegistered(tx, {
      pqcKeypair,
      rest: REST,
      fee: { amount: [{ denom: BASE_DENOM, amount: "60000" }], gas: "600000" },
    });
    if (res.alreadyRegistered) {
      console.log("PQC: key already registered (no tx sent)");
      state.pqcRegistered = true;
    } else {
      const txr = await waitForTx(res.txHash);
      if (txr.code !== 0) throw new Error(`PQC registration failed: code ${txr.code} ${txr.raw_log}`);
      console.log(`PQC: registered — tx ${res.txHash} height ${txr.height}`);
      console.log(`     ${explorerTxUrl(EXPLORER, res.txHash)}`);
      state.pqcRegistrationTx = res.txHash;
      state.pqcRegistered = true;
    }
    saveState(state);
  } else {
    console.log(`PQC: already registered — tx ${state.pqcRegistrationTx} (recorded)`);
  }

  // --- 5. First hybrid-signed anchors ---
  async function anchor(action) {
    const key = `${action}Tx`;
    if (state[key]) {
      console.log(`${action}: already sent — ${state[key]} (recorded)`);
      return state[key];
    }
    const memo = `qwill:v1:${action}:${WILL_ID}`;
    console.log(`${action}: sending hybrid anchor (memo "${memo}") …`);
    const result = await tx.bankSend(
      owner.address,
      [{ denom: BASE_DENOM, amount: "1" }],
      { memo },
    );
    const txr = await waitForTx(result.transactionHash);
    if (txr.code !== 0) throw new Error(`${action} anchor failed: code ${txr.code} ${txr.raw_log}`);
    console.log(`${action}: tx ${result.transactionHash} height ${txr.height} time ${txr.timestamp}`);
    console.log(`     ${explorerTxUrl(EXPLORER, result.transactionHash)}`);
    state[key] = result.transactionHash;
    state[`${action}Height`] = txr.height;
    state[`${action}Time`] = txr.timestamp;
    saveState(state);
    return result.transactionHash;
  }

  await anchor("register");
  await anchor("checkin");

  // --- 6. Summary ---
  const finalBalance = await getBalance(owner.address);
  console.log("\nDay-2 complete:");
  console.log(`  owner:        ${owner.address}`);
  console.log(`  beneficiary:  ${beneficiary.address}`);
  console.log(`  will:         ${WILL_ID}`);
  console.log(`  pqc tx:       ${state.pqcRegistrationTx || "(already registered)"}`);
  console.log(`  register tx:  ${state.registerTx}`);
  console.log(`  check-in tx:  ${state.checkinTx}`);
  console.log(`  balance left: ${finalBalance} uqor`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
