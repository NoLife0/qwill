/**
 * Unit tests for the QoreSeal envelope (seal.ts) + commitment (crypto.ts).
 * Pure crypto, no chain: seal → open round-trips, tampering is detected,
 * and the commitment binds the exact envelope bytes.
 * Run with `npm test` (esbuild-bundles this file + src, then node --test).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { envelopeCommitment, verifyCommitment } from "../src/qwill/crypto";
import {
  SEAL_PURPOSE,
  generateSealKeys,
  openEnvelope,
  sealInstructions,
} from "../src/qwill/seal";

const CHAIN_ID = "qorechain-diana";
const PLAINTEXT =
  "QWill demo recovery note: test vault, no real funds. Beneficiary reads this only after a verified lapse.";

describe("QoreSeal envelope (ML-KEM-1024 + AES-256-GCM)", () => {
  it("seals to a recipient key and only that key opens it", async () => {
    const keys = generateSealKeys();
    const other = generateSealKeys();
    const envelope = await sealInstructions({
      chainId: CHAIN_ID,
      purpose: SEAL_PURPOSE,
      recipient: "qor1heir",
      recipientPublicKey: keys.publicKey,
      plaintext: PLAINTEXT,
    });
    assert.equal(envelope.version, 1);
    assert.equal(envelope.chainId, CHAIN_ID);
    assert.equal(envelope.recipient, "qor1heir");

    const opened = await openEnvelope({
      chainId: CHAIN_ID,
      purpose: SEAL_PURPOSE,
      envelope,
      secretKey: keys.secretKey,
    });
    assert.equal(new TextDecoder().decode(opened), PLAINTEXT);

    // A different key cannot open it (decapsulation + GCM auth fail).
    await assert.rejects(
      openEnvelope({
        chainId: CHAIN_ID,
        purpose: SEAL_PURPOSE,
        envelope,
        secretKey: other.secretKey,
      }),
    );
  });

  it("refuses envelopes bound to another chain or purpose", async () => {
    const keys = generateSealKeys();
    const envelope = await sealInstructions({
      chainId: CHAIN_ID,
      purpose: SEAL_PURPOSE,
      recipient: "qor1heir",
      recipientPublicKey: keys.publicKey,
      plaintext: PLAINTEXT,
    });
    await assert.rejects(
      openEnvelope({
        chainId: "qorechain-vladi",
        purpose: SEAL_PURPOSE,
        envelope,
        secretKey: keys.secretKey,
      }),
      /bound to/,
    );
    await assert.rejects(
      openEnvelope({
        chainId: CHAIN_ID,
        purpose: "other-purpose",
        envelope,
        secretKey: keys.secretKey,
      }),
      /bound to/,
    );
  });

  it("rejects a non-ML-KEM-1024 recipient key", async () => {
    const keys = generateSealKeys();
    await assert.rejects(
      sealInstructions({
        chainId: CHAIN_ID,
        purpose: SEAL_PURPOSE,
        recipient: "qor1heir",
        recipientPublicKey: keys.publicKey.slice(0, 100),
        plaintext: PLAINTEXT,
      }),
      /1568 bytes/,
    );
  });

  it("commitment binds the exact envelope: any tamper fails verification", async () => {
    const keys = generateSealKeys();
    const envelope = await sealInstructions({
      chainId: CHAIN_ID,
      purpose: SEAL_PURPOSE,
      recipient: "qor1heir",
      recipientPublicKey: keys.publicKey,
      plaintext: PLAINTEXT,
    });
    const commitment = await envelopeCommitment(envelope);
    assert.equal(await verifyCommitment(envelope, commitment), true);

    // Tamper with the payload ciphertext: commitment no longer matches…
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
    assert.equal(await verifyCommitment(tampered, commitment), false);
    // …and decryption fails authentication even if the commitment were skipped.
    await assert.rejects(
      openEnvelope({
        chainId: CHAIN_ID,
        purpose: SEAL_PURPOSE,
        envelope: tampered,
        secretKey: keys.secretKey,
      }),
    );

    // Tamper with the KEM blob: commitment fails too.
    const tamperedKem = { ...envelope, kemCiphertext: envelope.kemCiphertext.slice(0, -4) + "AAAA" };
    assert.equal(await verifyCommitment(tamperedKem, commitment), false);
  });

  it("two seals of the same plaintext differ (random data key + nonces)", async () => {
    const keys = generateSealKeys();
    const opts = {
      chainId: CHAIN_ID,
      purpose: SEAL_PURPOSE,
      recipient: "qor1heir",
      recipientPublicKey: keys.publicKey,
      plaintext: PLAINTEXT,
    };
    const a = await sealInstructions(opts);
    const b = await sealInstructions(opts);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.kemCiphertext, b.kemCiphertext);
    assert.equal(await envelopeCommitment(a) === (await envelopeCommitment(b)), false);
  });
});
