/**
 * Unit tests for the QWill switch + history projection (pure logic, no chain).
 * Run with `npm test` (esbuild-bundles this file + src, then node --test).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyCheckIn, canClaim, deadlineOf, isLapsed, statusAt, timeLeftSec } from "../src/qwill/switch";
import { parseAnchorMemo, projectWillFromHistory } from "../src/qwill/history";
import type { AnchoredTx, WillRecord } from "../src/qwill/types";

function will(over: Partial<WillRecord> = {}): WillRecord {
  return {
    id: "qwill-demo-001",
    owner: "qor1owner",
    beneficiary: "qor1heir",
    checkInIntervalSec: 30 * 24 * 60 * 60,
    createdAt: 1_000_000,
    lastCheckInAt: 1_000_000,
    commitment: "deadbeef",
    envelopeUri: "ipfs://demo",
    registrationTx: "ABC",
    status: "active",
    ...over,
  };
}

describe("dead-man's switch", () => {
  it("stays active before the deadline, lapses after it", () => {
    const w = will();
    assert.equal(deadlineOf(w), 1_000_000 + 30 * 24 * 60 * 60);
    assert.equal(isLapsed(w, deadlineOf(w)), false);
    assert.equal(isLapsed(w, deadlineOf(w) + 1), true);
    assert.equal(statusAt(w, deadlineOf(w) + 1), "lapsed");
    assert.equal(timeLeftSec(w, 1_000_000), 30 * 24 * 60 * 60);
  });

  it("a check-in pushes the deadline out by the full interval", () => {
    const moved = applyCheckIn(will(), 2_000_000);
    assert.equal(moved.lastCheckInAt, 2_000_000);
    assert.equal(deadlineOf(moved), 2_000_000 + 30 * 24 * 60 * 60);
  });

  it("stale or terminal check-ins are ignored", () => {
    const w = will();
    assert.equal(applyCheckIn(w, 999_999).lastCheckInAt, 1_000_000);
    assert.equal(applyCheckIn(will({ status: "claimed" }), 2_000_000).lastCheckInAt, 1_000_000);
  });

  it("only the beneficiary may claim, and only after a lapse", () => {
    const w = will();
    const t = deadlineOf(w) + 1;
    assert.equal(canClaim(w, "qor1heir", t), true);
    assert.equal(canClaim(w, "qor1owner", t), false);
    assert.equal(canClaim(w, "qor1heir", deadlineOf(w)), false);
  });
});

describe("anchor memo parsing", () => {
  it("accepts qwill:v1 memos and rejects everything else", () => {
    assert.deepEqual(parseAnchorMemo("qwill:v1:register:qwill-demo-001"), {
      action: "register",
      willId: "qwill-demo-001",
    });
    assert.deepEqual(parseAnchorMemo("qwill:v1:checkin:qwill-demo-001"), {
      action: "checkin",
      willId: "qwill-demo-001",
    });
    assert.equal(parseAnchorMemo("qwill:v1:claim:qwill-demo-001")?.action, "claim");
    assert.equal(parseAnchorMemo("hello world"), null);
    assert.equal(parseAnchorMemo("qwill:v1:bogus:qwill-demo-001"), null);
    assert.equal(parseAnchorMemo("qwill:v2:checkin:qwill-demo-001"), null);
  });
});

describe("projection from history", () => {
  const anchored: AnchoredTx[] = [
    { hash: "R1", height: "10", atSec: 1_000_000, action: "register", willId: "qwill-demo-001", memo: "qwill:v1:register:qwill-demo-001" },
    { hash: "C1", height: "20", atSec: 1_500_000, action: "checkin", willId: "qwill-demo-001", memo: "qwill:v1:checkin:qwill-demo-001" },
    { hash: "X1", height: "30", atSec: 1_600_000, action: "checkin", willId: "other-will", memo: "qwill:v1:checkin:other-will" },
  ];
  const facts = {
    willId: "qwill-demo-001",
    owner: "qor1owner",
    beneficiary: "qor1heir",
    checkInIntervalSec: 30 * 24 * 60 * 60,
    commitment: "deadbeef",
    envelopeUri: "ipfs://demo",
  };

  it("rebuilds lastCheckInAt from the newest check-in and ignores other wills", () => {
    const proj = projectWillFromHistory(anchored, facts, 1_600_000);
    assert.ok(proj);
    assert.equal(proj.will.lastCheckInAt, 1_500_000);
    assert.equal(proj.will.registrationTx, "R1");
    assert.equal(proj.checkIns.length, 1);
    assert.equal(proj.status, "active");
  });

  it("reports lapsed once the chain clock passes the deadline", () => {
    const proj = projectWillFromHistory(anchored, facts, 1_500_000 + 30 * 24 * 60 * 60 + 1);
    assert.ok(proj);
    assert.equal(proj.status, "lapsed");
  });

  it("a claim after the deadline flips the will to claimed (terminal)", () => {
    const deadline = 1_500_000 + 30 * 24 * 60 * 60;
    const withClaim: AnchoredTx[] = [
      ...anchored,
      { hash: "K1", height: "40", atSec: deadline + 10, action: "claim", willId: "qwill-demo-001", memo: "qwill:v1:claim:qwill-demo-001" },
      // A check-in after the claim must be ignored: the will stays claimed.
      { hash: "C2", height: "50", atSec: deadline + 20, action: "checkin", willId: "qwill-demo-001", memo: "qwill:v1:checkin:qwill-demo-001" },
    ];
    const proj = projectWillFromHistory(withClaim, facts, deadline + 30);
    assert.ok(proj);
    assert.equal(proj.status, "claimed");
    assert.equal(proj.will.status, "claimed");
    assert.equal(proj.claim?.txHash, "K1");
    assert.equal(proj.will.lastCheckInAt, 1_500_000);
    assert.equal(canClaim(proj.will, "qor1heir", deadline + 30), false);
  });

  it("a premature claim (before the deadline) is ignored", () => {
    const withEarlyClaim: AnchoredTx[] = [
      ...anchored,
      { hash: "K0", height: "25", atSec: 1_600_000, action: "claim", willId: "qwill-demo-001", memo: "qwill:v1:claim:qwill-demo-001" },
    ];
    const proj = projectWillFromHistory(withEarlyClaim, facts, 1_600_000);
    assert.ok(proj);
    assert.equal(proj.status, "active");
    assert.equal(proj.claim, undefined);
  });

  it("returns null without a registration anchor", () => {
    const noReg = anchored.filter((t) => t.action !== "register");
    assert.equal(projectWillFromHistory(noReg, facts, 1_600_000), null);
  });
});
