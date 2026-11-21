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
- `src/qwill/types.ts` — the will / check-in / claim data model.
- `src/qwill/switch.ts` — the dead-man's switch: pure lapse and claim logic.
- `src/qwill/chain.ts` — `@qorechain/sdk` bootstrap: account derivation,
  ML-DSA-87 key registration (`ensurePqcRegistered`) and hybrid signing.
- `src/qwill/crypto.ts` — envelope commitment hashing and the QoreSeal
  encryption boundary.
- `src/App.tsx` — the web UI (from the official starter, being rebuilt into
  the QWill flow: register → check in → claim).

## Quickstart

```sh
npm install
npm run dev        # http://localhost:5173
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

## Roadmap

- **Day 1 (20 Nov)** — scaffold from `create-qorechain-dapp`, data model,
  switch logic, chain + crypto skeletons. ✅
- **Day 2 (21 Nov)** — register the project's ML-DSA-87 key, fund from the
  faucet, first hybrid-signed registration + check-in transactions on testnet,
  will state read back from chain. ✅ (tx hashes above)
- **Day 3 (22 Nov)** — beneficiary claim flow, QoreSeal envelope encryption,
  UI polish.
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
- Next: heir-claim flow, QoreSeal envelope encryption, demo.
