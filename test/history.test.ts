/**
 * Unit tests for `listAnchoredTxs` (history.ts) with a stubbed fetch:
 * RPC tx_search lists hashes, REST tx-by-hash returns memo + block time.
 * Run with `npm test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listAnchoredTxs } from "../src/qwill/history";

const OWNER = "qor1owner";

function stubFetch() {
  const calls: string[] = [];
  const stub = async (url: string) => {
    calls.push(url);
    const json = async () => {
      if (url.includes("/tx_search")) {
        return {
          result: {
            total_count: "3",
            txs: [
              { hash: "R1", height: "10", tx_result: { code: 0 } },
              { hash: "C1", height: "20", tx_result: { code: 0 } },
              { hash: "F1", height: "15", tx_result: { code: 0 } },
            ],
          },
        };
      }
      if (url.includes("/txs/R1")) {
        return {
          tx: { body: { memo: "qwill:v1:register:qwill-demo-002" } },
          tx_response: { height: "10", timestamp: "2026-11-22T03:34:54Z", code: 0 },
        };
      }
      if (url.includes("/txs/C1")) {
        return {
          tx: { body: { memo: "qwill:v1:checkin:qwill-demo-002" } },
          tx_response: { height: "20", timestamp: "2026-11-22T03:34:59Z", code: 0 },
        };
      }
      // F1 is a non-QWill tx (fund transfer) — filtered out by memo.
      return {
        tx: { body: { memo: "qwill:v1:fund:qwill-demo-002" } },
        tx_response: { height: "15", timestamp: "2026-11-22T03:34:50Z", code: 0 },
      };
    };
    return { ok: true, json };
  };
  return { stub, calls };
}

describe("listAnchoredTxs (RPC tx_search + REST tx-by-hash)", () => {
  it("keeps only QWill anchors, newest first, with block times", async () => {
    const { stub, calls } = stubFetch();
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      stub as unknown as typeof fetch;
    try {
      const found = await listAnchoredTxs(OWNER, "https://rest.example", "https://rpc.example");
      assert.equal(found.length, 2);
      assert.equal(found[0].action, "checkin");
      assert.equal(found[0].hash, "C1");
      assert.equal(found[0].atSec, Math.floor(Date.parse("2026-11-22T03:34:59Z") / 1000));
      assert.equal(found[1].action, "register");
      assert.equal(found[1].hash, "R1");
      assert.ok(calls.some((u) => u.includes("/tx_search")));
      // The CometBFT query must be double-quoted, and order_by must be the
      // quoted string "asc" (the RPC parses every param value as JSON).
      const searchCall = calls.find((u) => u.includes("/tx_search"))!;
      const qp = new URL(searchCall).searchParams;
      assert.equal(qp.get("query"), `"message.sender='${OWNER}'"`);
      assert.equal(qp.get("order_by"), '"asc"');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws a clear error when the RPC search fails", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    try {
      await assert.rejects(listAnchoredTxs(OWNER, "https://rest.example", "https://rpc.example"), /tx search failed/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
