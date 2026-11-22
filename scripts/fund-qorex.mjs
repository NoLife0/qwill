/**
 * One-off: fund the user's fresh QoreX testnet wallet from the QWill
 * project SDK account so he can pay the registration step-4 proof fee.
 * TESTNET ONLY. Mnemonic loaded from the project file, never printed.
 * Usage: node scripts/fund-qorex.mjs <qor1-address> [amount-uqor]
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sdk = require("@qorechain/sdk");
const {
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  createClient,
  explorerTxUrl,
} = sdk;

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EXPLORER = { explorerUrl: "https://explore.qore.network" };
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..", "..");
const MNEMONIC_FILE = resolve(PROJECT_DIR, ".qwill-testnet-mnemonic");

const TO = process.argv[2];
const AMOUNT = process.argv[3] || "2000000"; // 2 QOR default
if (!TO || !TO.startsWith("qor1")) throw new Error("usage: fund-qorex.mjs <qor1-address> [uqor]");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTx(hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.ok) {
      const json = await res.json();
      if (json.tx_response) return json.tx_response;
    }
    if (Date.now() > deadline) throw new Error(`tx ${hash} not indexed within timeout`);
    await sleep(3000);
  }
}

const mnemonic = readFileSync(MNEMONIC_FILE, "utf8").trim();
const owner = await deriveNativeAccount(mnemonic);
console.log(`From (project testnet): ${owner.address}`);
console.log(`To (user QoreX):        ${TO}`);
console.log(`Amount:                 ${AMOUNT} uqor`);

const client = createClient({ endpoints: { rest: REST, rpc: RPC } });
const signer = await directSignerFromPrivateKey(owner.privateKey, "qor");
const pqcKeypair = derivePqcCanonical(owner.address, mnemonic);
const tx = await client.connectTx(signer, { pqcKeypair });

const result = await tx.bankSend(TO, [{ denom: "uqor", amount: AMOUNT }], {
  memo: "qwill:v1:qorex-fund",
});
const txr = await waitForTx(result.transactionHash);
if (txr.code !== 0) throw new Error(`fund tx failed: code ${txr.code} ${txr.raw_log}`);
console.log(`Fund tx: ${result.transactionHash} height ${txr.height}`);
console.log(explorerTxUrl(EXPLORER, result.transactionHash));
