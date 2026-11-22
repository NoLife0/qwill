/**
 * QWill Day-3 runner — end-to-end lapse → claim on testnet.
 *
 * Flow (idempotent; safe to re-run — completed steps are recorded in the
 * state file and skipped):
 *   1. Load the project testnet mnemonic (same file as Day 2, outside the
 *      repo) and verify the derived owner/beneficiary match Day 2.
 *   2. Fund the beneficiary (5 test QOR) from the owner.
 *   3. Register the beneficiary's ML-DSA-87 key (`ensurePqcRegistered`).
 *   4. Generate the beneficiary's ML-KEM-1024 seal keys, publish the public
 *      key on-chain (`MsgRegisterKEMKey`), verify it via `fetchKemKey`.
 *   5. Seal the demo recovery instructions to the beneficiary's REGISTERED
 *      key (QoreSeal v1 construction, see src/qwill/seal.ts) and record the
 *      envelope commitment (SHA-256 over the canonical envelope JSON).
 *   6. Owner anchors `qwill:v1:register:qwill-demo-002` and
 *      `qwill:v1:checkin:qwill-demo-002` (hybrid-signed).
 *   7. Wait for a real lapse: the demo interval is 300 s (5 min), so the
 *      runner polls the latest block time until it passes
 *      last-check-in + 300 s, then re-derives the will from chain history
 *      and confirms `lapsed` + `canClaim(beneficiary)`.
 *   8. Beneficiary anchors `qwill:v1:claim:qwill-demo-002` (hybrid-signed
 *      from the beneficiary's own session).
 *   9. Re-project from chain history: status must be `claimed`.
 *  10. Release: commitment-check the envelope, then open it with the
 *      beneficiary's ML-KEM secret key and compare with the original text.
 *
 * TESTNET ONLY (`qorechain-diana`). The demo instructions are non-sensitive
 * test text. The mnemonic is NEVER printed or logged.
 *
 * Usage: node scripts/day3.mjs [--will qwill-demo-002] [--interval 300]
 */
import { createRequire } from "node:module";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const sdk = require("@qorechain/sdk");
const {
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  createClient,
  ensurePqcRegistered,
  fetchKemKey,
  explorerTxUrl,
  explorerAddressUrl,
  KEM_ALGORITHM_ML_KEM_1024,
} = sdk;

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EXPLORER = { explorerUrl: "https://explore.qore.network" };
const BASE_DENOM = "uqor";
const CHAIN_ID = "qorechain-diana";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..", "..");
const MNEMONIC_FILE =
  process.env.QWILL_MNEMONIC_FILE || resolve(PROJECT_DIR, ".qwill-testnet-mnemonic");
const DAY2_STATE_FILE = resolve(PROJECT_DIR, ".qwill-day2-state.json");
const STATE_FILE =
  process.env.QWILL_DAY3_STATE_FILE || resolve(PROJECT_DIR, ".qwill-day3-state.json");

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WILL_ID = argVal("--will", "qwill-demo-002");
const INTERVAL_SEC = Number(argVal("--interval", "300"));

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

function b64encode(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function b64decode(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
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
      if (json.tx_response) return json.tx_response;
    }
    if (Date.now() > deadline) throw new Error(`tx ${hash} not indexed within timeout`);
    await sleep(3000);
  }
}

async function latestBlockTimeSec() {
  const res = await fetch(`${REST}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  if (!res.ok) throw new Error(`latest block query failed: HTTP ${res.status}`);
  const json = await res.json();
  return Math.floor(Date.parse(json.block.header.time) / 1000);
}

async function main() {
  // --- 0. Bundle the real app code and import it (no duplicated logic) ---
  // The bundle lives inside the repo dir so node resolves @qorechain/* from
  // qwill/node_modules; it is deleted again right after the import.
  const bundleFile = join(SCRIPT_DIR, ".day3-bundle.tmp.mjs");
  let qwill;
  try {
    await build({
      entryPoints: [join(SCRIPT_DIR, "day3-entry.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundleFile,
      external: ["@qorechain/sdk", "@qorechain/pqc"],
      logLevel: "silent",
    });
    qwill = await import(bundleFile);
  } finally {
    rmSync(bundleFile, { force: true });
  }

  // --- 1. Mnemonic + accounts (must match Day 2) ---
  if (!existsSync(MNEMONIC_FILE)) throw new Error(`mnemonic file missing: ${MNEMONIC_FILE}`);
  const mnemonic = readFileSync(MNEMONIC_FILE, "utf8").trim();
  const owner = await deriveNativeAccount(mnemonic);
  const beneficiary = await deriveNativeAccount(mnemonic, { accountIndex: 1 });
  const day2 = loadStateFile(DAY2_STATE_FILE);
  if (day2.address && day2.address !== owner.address) {
    throw new Error(`owner mismatch with Day 2: ${owner.address} != ${day2.address}`);
  }
  if (day2.beneficiary && day2.beneficiary !== beneficiary.address) {
    throw new Error(`beneficiary mismatch with Day 2: ${beneficiary.address} != ${day2.beneficiary}`);
  }
  console.log(`Owner (testnet):       ${owner.address}`);
  console.log(`Beneficiary (testnet): ${beneficiary.address}`);
  console.log(`Will:                  ${WILL_ID} (demo interval ${INTERVAL_SEC}s)`);

  const state = loadState();
  state.address = owner.address;
  state.beneficiary = beneficiary.address;
  state.willId = WILL_ID;
  state.intervalSec = INTERVAL_SEC;
  saveState(state);

  // --- 2. Sessions (owner + beneficiary) ---
  const client = createClient({ endpoints: { rest: REST, rpc: RPC } });
  async function sessionFor(account) {
    const signer = await directSignerFromPrivateKey(account.privateKey, "qor");
    const pqcKeypair = derivePqcCanonical(account.address, mnemonic);
    const tx = await client.connectTx(signer, { pqcKeypair });
    return { client, address: account.address, tx, pqcKeypair };
  }
  const ownerSession = await sessionFor(owner);
  const beneficiarySession = await sessionFor(beneficiary);

  // --- 3. Fund the beneficiary (5 QOR) so it can pay its own txs ---
  if (!state.fundTx) {
    const ownerBal = await getBalance(owner.address);
    console.log(`Owner balance: ${ownerBal} uqor`);
    if (ownerBal < 6_000_000n) throw new Error(`owner balance ${ownerBal} too low to fund beneficiary`);
    console.log("Fund: owner → beneficiary 5,000,000 uqor …");
    const res = await ownerSession.tx.bankSend(
      beneficiary.address,
      [{ denom: BASE_DENOM, amount: "5000000" }],
      { memo: `qwill:v1:fund:${WILL_ID}` },
    );
    const hash = res.transactionHash ?? res.hash;
    const txr = await waitForTx(hash);
    if (txr.code !== 0) throw new Error(`fund tx failed: code ${txr.code} ${txr.raw_log}`);
    console.log(`Fund: tx ${hash} height ${txr.height}`);
    state.fundTx = hash;
    saveState(state);
  } else {
    console.log(`Fund: already sent — ${state.fundTx}`);
  }

  // --- 4. Beneficiary ML-DSA-87 key registration ---
  if (!state.beneficiaryPqcTx && !state.beneficiaryPqcRegistered) {
    console.log("PQC: registering beneficiary ML-DSA-87 key …");
    const res = await ensurePqcRegistered(beneficiarySession.tx, {
      pqcKeypair: beneficiarySession.pqcKeypair,
      rest: REST,
      fee: { amount: [{ denom: BASE_DENOM, amount: "60000" }], gas: "600000" },
    });
    if (res.alreadyRegistered) {
      console.log("PQC: beneficiary key already registered (no tx sent)");
      state.beneficiaryPqcRegistered = true;
    } else {
      const txr = await waitForTx(res.txHash);
      if (txr.code !== 0) throw new Error(`beneficiary PQC registration failed: code ${txr.code}`);
      console.log(`PQC: beneficiary registered — tx ${res.txHash} height ${txr.height}`);
      console.log(`     ${explorerTxUrl(EXPLORER, res.txHash)}`);
      state.beneficiaryPqcTx = res.txHash;
      state.beneficiaryPqcRegistered = true;
    }
    saveState(state);
  } else {
    console.log(`PQC: beneficiary already registered — ${state.beneficiaryPqcTx || "(recorded)"}`);
  }

  // --- 5. Beneficiary ML-KEM-1024 seal keys: generate + publish on-chain ---
  let sealSecretKey;
  if (state.sealSecretKeyB64) {
    sealSecretKey = b64decode(state.sealSecretKeyB64);
    console.log("KEM: reusing seal keys from state file");
  } else {
    const keys = qwill.generateSealKeys();
    sealSecretKey = keys.secretKey;
    state.sealSecretKeyB64 = b64encode(keys.secretKey);
    state.sealPublicKeyB64 = b64encode(keys.publicKey);
    saveState(state);
    console.log("KEM: generated fresh ML-KEM-1024 seal keys (secret stored in state file, mode 600)");
  }
  const sealPublicKey = b64decode(state.sealPublicKeyB64);
  const registered = await fetchKemKey({ rest: REST, address: beneficiary.address });
  const keyMatches =
    registered.found &&
    registered.key.publicKey.length === sealPublicKey.length &&
    Buffer.from(registered.key.publicKey).equals(Buffer.from(sealPublicKey));
  if (!keyMatches) {
    console.log("KEM: publishing beneficiary ML-KEM-1024 public key on-chain (MsgRegisterKEMKey) …");
    const registerKemKeyMsg =
      sdk.msg?.pqc?.registerKemKey ?? sdk.pqcMsg.registerKemKey;
    const msgObj = registerKemKeyMsg({
      sender: beneficiary.address,
      algorithmId: KEM_ALGORITHM_ML_KEM_1024,
      publicKey: sealPublicKey,
    });
    const res = await beneficiarySession.tx.signAndBroadcast(
      [msgObj],
      "auto",
      `qwill:v1:kem:${WILL_ID}`,
    );
    const hash = res.transactionHash ?? res.hash;
    const txr = await waitForTx(hash);
    if (txr.code !== 0) throw new Error(`KEM key registration failed: code ${txr.code} ${txr.raw_log}`);
    console.log(`KEM: published — tx ${hash} height ${txr.height}`);
    console.log(`     ${explorerTxUrl(EXPLORER, hash)}`);
    state.kemRegisterTx = hash;
    saveState(state);
  } else {
    console.log(`KEM: key already on-chain (height ${registered.key.registeredHeight})`);
  }
  const onChainKey = await fetchKemKey({ rest: REST, address: beneficiary.address });
  if (!onChainKey.found) throw new Error("KEM key not found on-chain after registration");
  console.log(
    `KEM: registry confirms ${onChainKey.key.algorithmName} key for ${beneficiary.address} (height ${onChainKey.key.registeredHeight})`,
  );

  // --- 6. Seal the demo recovery instructions to the REGISTERED key ---
  const INSTRUCTIONS =
    `QWill demo — will ${WILL_ID} (QoreChain testnet only, no real funds).\n` +
    `Owner: ${owner.address}\nBeneficiary: ${beneficiary.address}\n` +
    `If you are reading this, the dead-man's switch worked end to end: the owner stopped checking in, ` +
    `the will lapsed on-chain (block time), and the beneficiary claimed and decrypted these instructions.\n` +
    `Real recovery instructions would list vault locations, exchange accounts and contacts — this demo lists none.`;
  if (!state.envelope) {
    console.log("Seal: encrypting demo instructions to the beneficiary's registered ML-KEM key …");
    const envelope = await qwill.sealInstructions({
      chainId: CHAIN_ID,
      purpose: qwill.SEAL_PURPOSE,
      recipient: beneficiary.address,
      recipientPublicKey: onChainKey.key.publicKey,
      plaintext: INSTRUCTIONS,
    });
    const commitment = await qwill.envelopeCommitment(envelope);
    state.envelope = envelope;
    state.commitment = commitment;
    state.instructions = INSTRUCTIONS;
    saveState(state);
    console.log(`Seal: envelope sealed, commitment ${commitment.slice(0, 16)}… (full in state file)`);
  } else {
    console.log(`Seal: envelope already sealed, commitment ${(state.commitment || "").slice(0, 16)}…`);
  }

  // --- 7. Owner anchors: register + check-in ---
  async function anchor(session, action) {
    const key = `${action}Tx`;
    if (state[key]) {
      console.log(`${action}: already sent — ${state[key]} (recorded)`);
      return state[key];
    }
    const memo = `qwill:v1:${action}:${WILL_ID}`;
    console.log(`${action}: sending hybrid anchor (memo "${memo}") …`);
    const hash = await qwill.anchorAction(session, memo);
    const txr = await waitForTx(hash);
    if (txr.code !== 0) throw new Error(`${action} anchor failed: code ${txr.code} ${txr.raw_log}`);
    console.log(`${action}: tx ${hash} height ${txr.height} time ${txr.timestamp}`);
    console.log(`     ${explorerTxUrl(EXPLORER, hash)}`);
    state[key] = hash;
    state[`${action}Height`] = txr.height;
    state[`${action}Time`] = txr.timestamp;
    saveState(state);
    return hash;
  }
  await anchor(ownerSession, "register");
  await anchor(ownerSession, "checkin");

  const checkinSec = Math.floor(Date.parse(state.checkinTime) / 1000);
  const deadlineSec = checkinSec + INTERVAL_SEC;
  console.log(
    `Lapse: last check-in (block time) ${state.checkinTime}, deadline ${new Date(deadlineSec * 1000).toISOString()}`,
  );

  // --- 8. Wait for a real lapse (chain block time), then verify from history ---
  for (;;) {
    const nowSec = await latestBlockTimeSec();
    const left = deadlineSec - nowSec;
    if (left <= 0) {
      console.log(`Lapse: chain time ${new Date(nowSec * 1000).toISOString()} is past the deadline — lapsed.`);
      break;
    }
    console.log(`Lapse: waiting… ${left}s left (chain time ${new Date(nowSec * 1000).toISOString()})`);
    await sleep(15_000);
  }
  const nowSec = await latestBlockTimeSec();
  const anchoredOwner = await qwill.listAnchoredTxs(owner.address);
  const anchoredBeneficiary = await qwill.listAnchoredTxs(beneficiary.address);
  const facts = {
    willId: WILL_ID,
    owner: owner.address,
    beneficiary: beneficiary.address,
    checkInIntervalSec: INTERVAL_SEC,
    commitment: state.commitment,
    envelopeUri: "off-chain:day3-state",
  };
  const proj = qwill.projectWillFromHistory(
    [...anchoredOwner, ...anchoredBeneficiary],
    facts,
    nowSec,
  );
  if (!proj) throw new Error("projection failed: no registration anchor found in history");
  console.log(`Projection: status ${proj.status}, last check-in ${new Date(proj.will.lastCheckInAt * 1000).toISOString()}, ${proj.checkIns.length} check-in(s)`);
  if (proj.status !== "lapsed") throw new Error(`expected lapsed, got ${proj.status} — aborting claim`);
  const decision = qwill.checkClaimable(proj.will, beneficiary.address, nowSec);
  console.log(`Claimable: lapsed=${decision.lapsed} canClaim(beneficiary)=${decision.canClaim}`);
  if (!decision.canClaim) throw new Error("beneficiary may not claim — aborting");

  // --- 9. Beneficiary claim anchor (hybrid-signed, beneficiary session) ---
  if (!state.claimTx) {
    console.log("Claim: beneficiary sending hybrid claim anchor …");
    const hash = await qwill.sendClaimAnchor(beneficiarySession, WILL_ID);
    const txr = await waitForTx(hash);
    if (txr.code !== 0) throw new Error(`claim anchor failed: code ${txr.code} ${txr.raw_log}`);
    console.log(`Claim: tx ${hash} height ${txr.height} time ${txr.timestamp}`);
    console.log(`     ${explorerTxUrl(EXPLORER, hash)}`);
    state.claimTx = hash;
    state.claimHeight = txr.height;
    state.claimTime = txr.timestamp;
    saveState(state);
  } else {
    console.log(`Claim: already sent — ${state.claimTx}`);
  }
  const claimSec = Math.floor(Date.parse(state.claimTime) / 1000);
  if (claimSec <= deadlineSec) {
    throw new Error(`claim block time ${state.claimTime} is not past the deadline — invalid claim`);
  }
  console.log(`Claim: block time ${state.claimTime} is past the deadline — valid claim.`);

  // --- 10. Re-project from chain history: must be claimed ---
  const afterOwner = await qwill.listAnchoredTxs(owner.address);
  const afterBeneficiary = await qwill.listAnchoredTxs(beneficiary.address);
  const after = qwill.projectWillFromHistory(
    [...afterOwner, ...afterBeneficiary],
    facts,
    claimSec + 1,
  );
  if (!after || after.status !== "claimed" || after.claim?.txHash !== state.claimTx) {
    throw new Error(`post-claim projection is not claimed: ${JSON.stringify(after?.status)}`);
  }
  console.log(`Projection: status ${after.status}, claim tx ${after.claim.txHash}`);

  // --- 11. Release: commitment check, then decrypt as the beneficiary ---
  const released = await qwill.releaseEnvelope(state.envelope, state.commitment);
  const opened = await qwill.openEnvelope({
    chainId: CHAIN_ID,
    purpose: qwill.SEAL_PURPOSE,
    envelope: released,
    secretKey: sealSecretKey,
  });
  const openedText = new TextDecoder().decode(opened);
  if (openedText !== INSTRUCTIONS) throw new Error("decrypted instructions do not match the original");
  console.log("Release: commitment verified, envelope opened by the beneficiary.");
  console.log("--- decrypted demo instructions ---");
  console.log(openedText);
  console.log("--- end ---");

  // --- 12. Summary ---
  const finalOwnerBal = await getBalance(owner.address);
  const finalBeneficiaryBal = await getBalance(beneficiary.address);
  console.log("\nDay-3 end-to-end complete:");
  console.log(`  will:            ${WILL_ID} (interval ${INTERVAL_SEC}s)`);
  console.log(`  owner:           ${owner.address}`);
  console.log(`  beneficiary:     ${beneficiary.address}`);
  console.log(`  fund tx:         ${state.fundTx}`);
  console.log(`  beneficiary PQC: ${state.beneficiaryPqcTx || "(already registered)"}`);
  console.log(`  KEM register tx: ${state.kemRegisterTx || "(already on-chain)"}`);
  console.log(`  register tx:     ${state.registerTx}`);
  console.log(`  check-in tx:     ${state.checkinTx}`);
  console.log(`  claim tx:        ${state.claimTx}`);
  console.log(`  explorer (owner): ${explorerAddressUrl(EXPLORER, owner.address)}`);
  console.log(`  owner balance:   ${finalOwnerBal} uqor`);
  console.log(`  beneficiary bal: ${finalBeneficiaryBal} uqor`);
}

function loadStateFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
