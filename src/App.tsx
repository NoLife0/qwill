import { useEffect, useMemo, useState } from "react";

import { TESTNET } from "./qwill/config";
import { verifyCommitment } from "./qwill/crypto";
import { listAnchoredTxs, projectWillFromHistory } from "./qwill/history";
import { canClaim, deadlineOf, timeLeftSec } from "./qwill/switch";
import type { SealedEnvelope, WillRecord } from "./qwill/types";

// The public REST API sends no CORS headers, so the browser reaches it
// through the Vite dev server proxy (see .env / vite.config.ts).
const REST_URL = import.meta.env.VITE_QORE_REST_URL ?? "/lcd";
const RPC_URL = import.meta.env.VITE_QORE_RPC_URL ?? "/rpc";

const DEMO_OWNER = "qor1jycnxeftt8hw38kt32x93lt20rs7rqdddmczdc";
const DEMO_BENEFICIARY = "qor12hr9fsleukr4mw2w9vqkr98u4gjt8et78fw3g2";
const DEMO_WILL_ID = "qwill-demo-002";
/** Demo will lapses 5 minutes after its last check-in (see scripts/day3.mjs). */
const DEMO_INTERVAL_SEC = 300;

function fmtDuration(sec: number): string {
  const abs = Math.abs(Math.floor(sec));
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  active: { bg: "#dcfce7", fg: "#166534" },
  lapsed: { bg: "#fee2e2", fg: "#991b1b" },
  claimed: { bg: "#ede9fe", fg: "#5b21b6" },
  revoked: { bg: "#e5e7eb", fg: "#374151" },
};

export function App(): JSX.Element {
  const [owner, setOwner] = useState(DEMO_OWNER);
  const [beneficiary, setBeneficiary] = useState(DEMO_BENEFICIARY);
  const [willId, setWillId] = useState(DEMO_WILL_ID);
  const [intervalSec, setIntervalSec] = useState(DEMO_INTERVAL_SEC);
  const [claimant, setClaimant] = useState(DEMO_BENEFICIARY);
  const [will, setWill] = useState<WillRecord | null>(null);
  const [commitment, setCommitment] = useState("");
  const [checkIns, setCheckIns] = useState<
    { at: number; txHash: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  // Live countdown: the switch runs on chain block time, and this clock
  // ticks once a second so the deadline visibly counts down.
  useEffect(() => {
    const t = setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  const deadline = useMemo(
    () => (will ? deadlineOf(will) : null),
    [will],
  );
  const left = useMemo(
    () => (will ? timeLeftSec(will, nowSec) : null),
    [will, nowSec],
  );
  const claimable = useMemo(
    () =>
      will && claimant.trim()
        ? canClaim(will, claimant.trim(), nowSec)
        : false,
    [will, claimant, nowSec],
  );

  async function loadWill(): Promise<void> {
    setError(null);
    setWill(null);
    setCheckIns([]);
    if (!owner.trim() || !beneficiary.trim() || !willId.trim()) {
      setError("Owner, beneficiary and will id are all required.");
      return;
    }
    setLoading(true);
    try {
      const anchored = await listAnchoredTxs(owner.trim(), REST_URL, RPC_URL);
      const proj = projectWillFromHistory(
        anchored,
        {
          willId: willId.trim(),
          owner: owner.trim(),
          beneficiary: beneficiary.trim(),
          checkInIntervalSec: intervalSec,
          commitment: commitment.trim() || "—",
          envelopeUri: "off-chain",
        },
        nowSec,
      );
      if (!proj) {
        setError(
          `No registration anchor (qwill:v1:register:${willId.trim()}) found in ${owner.trim()}'s history.`,
        );
        return;
      }
      setWill(proj.will);
      setCheckIns(proj.checkIns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const [envelopeJson, setEnvelopeJson] = useState("");
  const [envelopeCommitment, setEnvelopeCommitment] = useState("");
  const [envelopeResult, setEnvelopeResult] = useState<string | null>(null);

  async function checkEnvelope(): Promise<void> {
    setEnvelopeResult(null);
    try {
      const envelope = JSON.parse(envelopeJson) as SealedEnvelope;
      const ok = await verifyCommitment(envelope, envelopeCommitment.trim());
      setEnvelopeResult(
        ok
          ? "Commitment matches — this is the registered envelope."
          : "Commitment MISMATCH — this envelope is not the registered one. Do not release it.",
      );
    } catch (err) {
      setEnvelopeResult(
        `Could not verify: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // The stored status is "active" until a claim lands; "lapsed" is derived
  // live from the countdown, so the pill flips the second the deadline passes.
  const displayStatus: string | null = useMemo(() => {
    if (!will) return null;
    if (will.status !== "active") return will.status;
    if (left !== null && left < 0) return "lapsed";
    return "active";
  }, [will, left]);
  const pill = displayStatus
    ? STATUS_STYLE[displayStatus] ?? STATUS_STYLE.active
    : null;

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 760,
        margin: "0 auto",
        padding: "2rem 1rem 4rem",
        lineHeight: 1.5,
        backgroundImage:
          "radial-gradient(circle, #d4d4d8 1px, transparent 1px)",
        backgroundSize: "22px 22px",
      }}
    >
      <header>
        <p style={{ margin: 0, color: "#6b7280", fontSize: "0.85rem" }}>
          QoreChain testnet &middot; <code>{TESTNET.chainId}</code> &middot;{" "}
          <a href={TESTNET.explorer}>explorer</a>
        </p>
        <h1 style={{ fontSize: "2rem", margin: "0.25rem 0" }}>QWill</h1>
        <p style={{ margin: 0, color: "#374151", maxWidth: 560 }}>
          A dead-man&rsquo;s switch for crypto inheritance. Check in to prove
          you&rsquo;re alive — every check-in is a hybrid-signed transaction
          (secp256k1 + ML-DSA-87). Stop checking in, and after your interval
          your beneficiary can claim and decrypt the recovery instructions
          you sealed to them with QoreSeal (ML-KEM-1024).
        </p>
      </header>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.15rem" }}>How it works</h2>
        <ol style={{ paddingLeft: "1.25rem", color: "#374151" }}>
          <li>
            <strong>Register a will</strong> — name a beneficiary and seal
            recovery instructions to their on-chain ML-KEM key. Only a
            commitment hash touches the chain.
          </li>
          <li>
            <strong>Check in</strong> — each check-in is a hybrid-signed
            transaction; its block time resets your countdown.
          </li>
          <li>
            <strong>Lapse</strong> — no check-in within your interval and the
            will lapses. The lapse is computed from block times, so anyone
            can verify it in the explorer.
          </li>
          <li>
            <strong>Claim</strong> — the beneficiary anchors a claim, the app
            verifies the commitment, then releases the envelope. Only their
            key opens it.
          </li>
        </ol>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.15rem" }}>Track a will on-chain</h2>
        <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 0 }}>
          Reads the owner&rsquo;s transaction history from the public testnet
          REST API and rebuilds the will — no wallet needed. The demo will{" "}
          <code>{DEMO_WILL_ID}</code> uses a 5-minute interval so the full
          register &rarr; check-in &rarr; lapse &rarr; claim flow fits in a
          demo.
        </p>
        <div
          style={{ display: "grid", gap: "0.5rem", maxWidth: 640 }}
        >
          <label>
            Owner <code>qor1&hellip;</code>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              style={{ display: "block", width: "100%", padding: "0.5rem" }}
            />
          </label>
          <label>
            Beneficiary <code>qor1&hellip;</code>
            <input
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              style={{ display: "block", width: "100%", padding: "0.5rem" }}
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <label style={{ flex: 1 }}>
              Will id
              <input
                value={willId}
                onChange={(e) => setWillId(e.target.value)}
                style={{ display: "block", width: "100%", padding: "0.5rem" }}
              />
            </label>
            <label>
              Check-in interval (seconds)
              <input
                type="number"
                value={intervalSec}
                onChange={(e) =>
                  setIntervalSec(Number(e.target.value) || 0)
                }
                style={{ display: "block", width: "100%", padding: "0.5rem" }}
              />
            </label>
          </div>
          <label>
            Envelope commitment (optional — shown with the will if known)
            <input
              value={commitment}
              onChange={(e) => setCommitment(e.target.value)}
              placeholder="hex sha-256"
              style={{ display: "block", width: "100%", padding: "0.5rem" }}
            />
          </label>
          <div>
            <button
              onClick={loadWill}
              disabled={loading}
              style={{ padding: "0.5rem 1rem" }}
            >
              {loading ? "Reading chain…" : "Load will from chain"}
            </button>
          </div>
        </div>

        {error && (
          <p style={{ color: "#b00020", marginTop: "1rem" }} role="alert">
            {error}
          </p>
        )}

        {will && pill && deadline !== null && left !== null && (
          <div
            style={{
              marginTop: "1rem",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "1rem",
              background: "#fff",
            }}
          >
            <p style={{ margin: 0 }}>
              <span
                style={{
                  background: pill.bg,
                  color: pill.fg,
                  borderRadius: 999,
                  padding: "0.15rem 0.6rem",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                }}
              >
                {displayStatus?.toUpperCase()}
              </span>{" "}
              <code>{will.id}</code>
            </p>
            <p style={{ margin: "0.75rem 0 0" }}>
              {left >= 0 ? (
                <>
                  Proof-of-life margin:{" "}
                  <strong>{fmtDuration(left)}</strong> left — deadline{" "}
                  {fmtTime(deadline)}.
                </>
              ) : (
                <>
                  Lapsed <strong>{fmtDuration(left)} ago</strong> — deadline
                  was {fmtTime(deadline)}.
                </>
              )}
            </p>
            <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
              <li>
                Registered: {fmtTime(will.createdAt)} —{" "}
                <a
                  href={`${TESTNET.explorer}/tx/${will.registrationTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {will.registrationTx.slice(0, 12)}…
                </a>
              </li>
              <li>Last check-in: {fmtTime(will.lastCheckInAt)}</li>
              {checkIns.map((c) => (
                <li key={c.txHash}>
                  Check-in {fmtTime(c.at)} —{" "}
                  <a
                    href={`${TESTNET.explorer}/tx/${c.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.txHash.slice(0, 12)}…
                  </a>
                </li>
              ))}
            </ul>

            <div style={{ marginTop: "1rem" }}>
              <h3 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>
                Can this address claim?
              </h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  value={claimant}
                  onChange={(e) => setClaimant(e.target.value)}
                  placeholder="qor1… claimant"
                  style={{ flex: 1, padding: "0.5rem" }}
                  aria-label="Claimant address"
                />
              </div>
              <p style={{ margin: "0.5rem 0 0" }}>
                {claimant.trim() === will.beneficiary ? (
                  claimable ? (
                    <strong style={{ color: "#166534" }}>
                      Yes — the will has lapsed and this is the beneficiary.
                      A claim anchor can be sent.
                    </strong>
                  ) : displayStatus === "claimed" ? (
                    "This will was already claimed."
                  ) : (
                    "Not yet — the will has not lapsed."
                  )
                ) : (
                  "No — only the named beneficiary may claim."
                )}
              </p>
              <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>
                Signing a register / check-in / claim transaction needs a
                QoreX wallet on testnet — wallet connect is the next step
                after this demo UI; the flows themselves run today via{" "}
                <code>scripts/day2.mjs</code> and{" "}
                <code>scripts/day3.mjs</code>.
              </p>
            </div>
          </div>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.15rem" }}>Verify a released envelope</h2>
        <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 0 }}>
          Paste the sealed envelope JSON and the commitment recorded at
          registration. The app re-hashes the envelope and compares — a
          swapped or corrupted envelope is refused before any decryption.
        </p>
        <textarea
          value={envelopeJson}
          onChange={(e) => setEnvelopeJson(e.target.value)}
          placeholder='{"version": 1, "construction": "qoreseal-v1/mlkem1024+aes256gcm", …}'
          rows={5}
          style={{ display: "block", width: "100%", padding: "0.5rem" }}
        />
        <input
          value={envelopeCommitment}
          onChange={(e) => setEnvelopeCommitment(e.target.value)}
          placeholder="commitment (hex sha-256)"
          style={{
            display: "block",
            width: "100%",
            padding: "0.5rem",
            marginTop: "0.5rem",
          }}
        />
        <button
          onClick={checkEnvelope}
          style={{ padding: "0.5rem 1rem", marginTop: "0.5rem" }}
        >
          Verify commitment
        </button>
        {envelopeResult && (
          <p
            style={{
              color: envelopeResult.startsWith("Commitment matches")
                ? "#166534"
                : "#b00020",
              fontWeight: 600,
            }}
          >
            {envelopeResult}
          </p>
        )}
      </section>

      <footer style={{ marginTop: "2rem", color: "#6b7280", fontSize: "0.85rem" }}>
        <p>
          Built for the QoreChain Developer Fest — Build Before Q-Day,
          Quantum Pass. Testnet only. Source:{" "}
          <a href="https://github.com/NoLife0/qwill">NoLife0/qwill</a> ·{" "}
          <a href="https://build.qorechain.io/p/qwill">project page</a>
        </p>
      </footer>
    </main>
  );
}
