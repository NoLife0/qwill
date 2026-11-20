# AI usage

QWill is designed and directed by its human owner (GitHub: NoLife0) and built
with an AI coding assistant (Muse) as the main implementation tool, for the
Build Before Q-Day "Best AI-Native Build" record.

## What the human decided

- The product itself: a dead-man's switch for crypto inheritance, and the
  lapse-and-release mechanic as the original feature.
- The category (Quantum Pass), the scope (register → check in → lapse →
  claim, nothing more), and the security rule that no plaintext secret ever
  goes on-chain.
- All accounts, wallets, registrations and the final submission are the
  owner's; the assistant never holds mainnet keys and never signs on the
  owner's behalf outside the project's own testnet accounts.

## What the AI did

- Recon of the official QoreChain documentation, kits and fest rules, and the
  build plan derived from them.
- Scaffolding via the official `create-qorechain-dapp` starter and drafting of
  the data model, switch logic, chain bootstrap and documentation in this
  repository, commit by commit, under the owner's direction.
- Testnet transaction wiring and debugging against the public endpoints.

## Verification

Every AI-produced claim about the chain (endpoints, SDK functions, fee and gas
figures) was checked against the official documentation at
docs.qorechain.io before being written into the code or this file, and the
on-chain results are verifiable by anyone in the public explorer
(explore.qore.network).
