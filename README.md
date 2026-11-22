# QWill — a dead-man's switch for crypto inheritance

**If you stop checking in, your beneficiary can recover what you left for them.
Every check-in is a hybrid-signed QoreChain transaction: classical secp256k1 +
post-quantum ML-DSA-87.**

Built for the [QoreChain Developer Fest — Build Before Q-Day](https://build.qorechain.io),
category **Quantum Pass**. Runs on the QoreChain testnet (`qorechain-diana`).

## The problem

Crypto wealth dies with its owner. Seed phrases are lost, passwords are never
shared, and families cannot recover assets when something happens to the one
person who held the keys. The usual fixes are bad: handing your seed phrase to
a relative today defeats self-custody, and a lawyer with an envelope is a
single point of failure.

There is a second, slower problem: even a perfectly kept will is written in
classical cryptography. Instructions and proofs signed with ECDSA alone will
not stay trustworthy once quantum computers can forge them — the exact threat
QoreChain exists to answer.

## How QWill works

1. **Register a will.** You name a beneficiary (a `qor1…` address) and write
   recovery instructions. The instructions are encrypted **client-side to your
   beneficiary** with QoreSeal (ML-KEM-1024, FIPS 203). Only a hash commitment
   of the encrypted envelope and the will's metadata ever touch the chain —
   never plaintext, never secrets.
2. **Check in to prove you are alive.** Each check-in is a real testnet
   transaction signed **hybrid** (secp256k1 + ML-DSA-87) through
   `@qorechain/sdk`. A check-in resets your countdown. Because the signature is
   post-quantum, the proof of life stays valid in a post-quantum world.
3. **If you lapse, the switch flips.** When no check-in lands within the
   interval you chose, the will becomes *releasable*. The lapse is computed
   from on-chain block times of your own transactions, so anyone can verify it
   in the explorer — no server decides who is "dead".
4. **Your beneficiary claims.** The beneficiary opens a claim; the app verifies
   the lapse against the chain, then releases the encrypted envelope. Only the
   beneficiary's key can decrypt it.

The original piece is the switch itself: lapse-and-release driven entirely by
hybrid-signed check-in transactions.

## On-chain vs off-chain

| On-chain (QoreChain testnet)                    | Off-chain (app storage)              |
| ----------------------------------------------- | ------------------------------------ |
| Will registration (hybrid-signed tx)            | The encrypted envelope (QoreSeal)    |
| Commitment hash of the encrypted envelope       | —                                    |
| Check-in transactions (the proof of life)       | —                                    |
| Beneficiary claim transaction                   | —                                    |
| Beneficiary address + check-in interval         | Plaintext instructions: **nowhere**  |

## Architecture

- `src/qwill/config.ts` — testnet endpoints and chain constants.
- `src/qwill/types.ts` — the will / check-in / claim data model, plus the
  QoreSeal envelope shape.
- `src/qwill/switch.ts` — the dead-man's switch: pure lapse and claim logic.
- `src/qwill/chain.ts` — `@qorechain/sdk` bootstrap: account derivation,
  ML-DSA-87 key registration (`ensurePqcRegistered`) and hybrid signing.
- `src/qwill/seal.ts` — QoreSeal v1 envelope: ML-KEM-1024 + AES-256-GCM,
  HKDF-bound to chain + purpose, built on `@qorechain/pqc`.
- `src/qwill/crypto.ts` — envelope commitment hashing (SHA-256 over the
  canonical envelope JSON) and verification on release.
- `src/qwill/history.ts` — will projection rebuilt from the owner's and
  beneficiary's on-chain transaction histories (register → check-in →
  lapse → claim, with premature claims ignored).
- `src/qwill/claim.ts` — the beneficiary claim flow: lapse check, claim
  anchor, commitment-checked envelope release.
- `src/App.tsx` — the web UI: track a will live from chain (status +
  countdown + claim eligibility) and verify a released envelope.
- `scripts/day2.mjs` — first hybrid-signed transactions (key registration,
  register + check-in anchors). `scripts/day3.mjs` — the full end-to-end:
  fund beneficiary, register its PQC + ML-KEM keys, seal, register,
  check in, wait for a real lapse, claim, release + decrypt.

## Quickstart

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (switch, history, QoreSeal envelope)
npm run typecheck
```

End-to-end on testnet (uses the project testnet mnemonic from a file
outside this repo — never printed, never committed):

```sh
node scripts/day2.mjs   # key registration + first register/check-in anchors
node scripts/day3.mjs   # beneficiary claim flow, end to end (see below)
```

You need a QoreChain testnet account with a registered ML-DSA-87 key and some
test QOR for fees:

- Wallet: [QoreX](https://docs.qorechain.io/qorex/overview/) (switch it to
  Testnet), or derive an account in code with `@qorechain/sdk`.
- Free test QOR: the faucet on the [Dashboard](https://dashboard.qorechain.io).
- Explorer: <https://explore.qore.network>

Network: chain id `qorechain-diana` · EVM chain id `9800` ·
REST `https://api-testnet.qore.host` · RPC `https://rpc-testnet.qore.host` ·
EVM RPC `https://evm-testnet.qore.host`.

**Project testnet address (owner):**
[`qor1jycnxeftt8hw38kt32x93lt20rs7rqdddmczdc`](https://explore.qore.network/address/qor1jycnxeftt8hw38kt32x93lt20rs7rqdddmczdc)
· beneficiary: `qor12hr9fsleukr4mw2w9vqkr98u4gjt8et78fw3g2`

First hybrid-signed transactions (Day 2, 21 Nov 2026, chain `qorechain-diana`):

| Step | Tx | Height |
| --- | --- | --- |
| ML-DSA-87 key registration (`ensurePqcRegistered`) | [`66D7C02F…34128F`](https://explore.qore.network/tx/66D7C02FB143EC19D38E1C46446F8BDCA100D497C4005D67CA737C37AA34128F) | 10471388 |
| Will registration anchor (memo `qwill:v1:register:qwill-demo-001`) | [`09FF534B…7FD97E`](https://explore.qore.network/tx/09FF534B2D1CA0B6AC8763A043CE40987D02851C5A17D3FAF9B4BBF3DE7FD97E) | 10471392 |
| Check-in anchor (memo `qwill:v1:checkin:qwill-demo-001`) | [`0AD9869B…A8599`](https://explore.qore.network/tx/0AD9869B5CC530BFF3F0AC9592A4533DDE3B6D424685AFB6DF4BB786164A8599) | 10471395 |

Reproduce with `node scripts/day2.mjs` (idempotent; reads the project
testnet mnemonic from a file outside this repo).

## Day 3 — beneficiary claim, end to end (22 Nov 2026)

A second demo will, `qwill-demo-002`, with a 5-minute check-in interval so
the whole life of a will fits in one run. `node scripts/day3.mjs` (idempotent)
ran it end to end on `qorechain-diana`:

| Step | Tx | Height |
| --- | --- | --- |
| Fund beneficiary (5 QOR, owner → beneficiary) | [`742B9EDB…216FC0B`](https://explore.qore.network/tx/742B9EDB620C4F2D7551983DE3726A726A852506B6CFEE286C9659B23216FC0B) | 10531324 |
| Beneficiary ML-DSA-87 key registration | [`D2CEDA6D…829C39`](https://explore.qore.network/tx/D2CEDA6DA0ED0B815CD0F17A273512323235F39A19A9B3073506F69894829C39) | 10531328 |
| Beneficiary ML-KEM-1024 key published (`MsgRegisterKEMKey`, verified via `fetchKemKey`) | [`0C4511CC…495FC`](https://explore.qore.network/tx/0C4511CC3F36396D92A19E4288FEB8B6EB040D59DC7FECE7E08DE235A30495FC) | 10531331 |
| Will registration anchor (memo `qwill:v1:register:qwill-demo-002`) | [`54C1C281…1437E`](https://explore.qore.network/tx/54C1C281C9E6A429132CD836BF727B0F5D8B0BFFDFCDA5A0C808EED36721437E) | 10531333 |
| Check-in anchor (memo `qwill:v1:checkin:qwill-demo-002`) | [`4A772F79…9E9338`](https://explore.qore.network/tx/4A772F7904BF985A5A7FC4E54E3DCB570C6097D8EEB2323ED16B8F7C5D9E9338) | 10531336 |
| Beneficiary claim anchor (memo `qwill:v1:claim:qwill-demo-002`) | [`189EAFB0…FD6D14`](https://explore.qore.network/tx/189EAFB0FF2B210C4CC9D26B47057C9BF1E92C9A36BD6464470D451D7BFD6D14) | 10531737 |

The envelope was sealed to the beneficiary's **registered** on-chain ML-KEM
key; commitment `7220f993cac45911…` (full hash in the run log). After the
check-in + 300 s lapse (verified from chain block times, projection status
`lapsed`), the beneficiary claimed, the projection flipped to `claimed`,
the commitment check passed, and the envelope decrypted to the original
demo instructions.

## Demo script (video, ≤ 3 min)

1. **0:00–0:20 — the problem.** Crypto dies with its owner; a will in
   classical crypto won't survive quantum computers either.
2. **0:20–0:50 — register.** Owner registers will `qwill-demo-002`, names
   the beneficiary, seals the instructions (QoreSeal, ML-KEM-1024).
   Explorer: registration tx.
3. **0:50–1:20 — check in.** Hybrid-signed check-in lands; the UI countdown
   resets. Explorer: check-in tx, hybrid signature visible.
4. **1:20–2:00 — lapse.** Countdown runs out (demo interval: 5 min,
   timelapsed). The UI flips to LAPSED; the lapse is block time, verifiable
   by anyone.
5. **2:00–2:40 — claim + decrypt.** Beneficiary anchors the claim;
   explorer: claim tx. App verifies the envelope commitment and releases
   it; the beneficiary decrypts and reads the instructions.
6. **2:40–3:00 — close.** One line: proof of life is a hybrid transaction,
   and the switch is the chain's own clock.

## Roadmap

- **Day 1 (20 Nov)** — scaffold from `create-qorechain-dapp`, data model,
  switch logic, chain + crypto skeletons. ✅
- **Day 2 (21 Nov)** — register the project's ML-DSA-87 key, fund from the
  faucet, first hybrid-signed registration + check-in transactions on testnet,
  will state read back from chain. ✅ (tx hashes above)
- **Day 3 (22 Nov)** — beneficiary claim flow, QoreSeal envelope encryption,
  UI polish. ✅ (tx hashes above; claim verified: code 0, block time past
  the deadline, projection `claimed`, envelope decrypted by the beneficiary)
- **By 2 Dec** — final README, demo video (≤ 3 min), submission checks.

## Kits and credits

- Scaffolded with the official
  [`create-qorechain-dapp`](https://build.qorechain.io/kits) starter
  (`fullstack-web` template: Vite + React + TypeScript).
- [`@qorechain/sdk`](https://github.com/qorechain/qorechain-sdk) — client,
  accounts and hybrid transaction signing.
- Planned: [`@qorechain/qoreseal`](https://github.com/qorechain/qoreseal)
  (ML-KEM-1024 envelope encryption) and QoreX for wallet connect.
- Developed with an AI coding assistant — see [AI_USAGE.md](AI_USAGE.md).

## Licence

MIT — see [LICENSE](LICENSE).

## Fest status

- Registered for Build Before Q-Day (Quantum Pass); project page: https://build.qorechain.io/p/qwill
- Day 2 complete on testnet: ML-DSA-87 key registered, first hybrid register + check-in anchors confirmed on chain.
- Day 3 complete on testnet: full register → check-in → lapse → claim flow on will `qwill-demo-002`, beneficiary ML-KEM-1024 key published + verified in the on-chain registry, envelope sealed to it, commitment verified, decrypted by the beneficiary. UI rebuilt: live will tracker + countdown + claim check + envelope verifier.
- Next: cover image, demo video (≤ 3 min, script in README), final submit checks before 2 Dec 23:59 UTC.
