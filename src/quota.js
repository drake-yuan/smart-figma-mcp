// quota.js — Credits quota (second anti-abuse gate) v2
//
// Iron rule: the authoritative deduction lives on the server; the client only caches
// "remaining balance". The local side can always be cracked, so it is never trusted.
//
// v2 changes:
//   - debit() now calls the server API /quota/debit
//   - server unreachable -> optimistic offline deduction from a local snapshot,
//     reconciled once back online
//   - each deduction generates a UUID idempotency key to prevent replay
//
// Cost-aligned pricing (matches the whitepaper):
//   pure digital  PURE_DIGITAL  = 0.1 credit  (no LLM, barely deducts)
//   semantic      SEMANTIC      = 1   credit
//   visual        VISUAL        = 5   credits (the real money burner, 50x)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CREDIT_COST = {
  PURE_DIGITAL: 0.1,
  SEMANTIC: 1,
  VISUAL: 5,
};

// Free tier (Hacker): usable without a license, pure-digital compile only, daily cap.
// Purpose: zero-friction trial right after `npm install`; without it nobody can try
// the tool and organic growth drops to zero.
export const FREE_TIER_DAILY_LIMIT = Number(process.env.FREE_TIER_DAILY_LIMIT || 10);
const FREE_TIER_PATH = path.join(os.homedir(), ".smart-figma", "free-tier.json");

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Free-tier daily counter (local, used when there is no license).
 * Only PURE_DIGITAL is allowed; other strategies prompt an upgrade.
 * @returns {{ok:boolean, reason?:string, used?:number, limit:number, remaining?:number}}
 */
export function freeTierDebit(strategy) {
  const limit = FREE_TIER_DAILY_LIMIT;
  if (strategy !== "PURE_DIGITAL") {
    return { ok: false, reason: "free_tier_pure_digital_only", limit };
  }
  let store = {};
  try { store = JSON.parse(fs.readFileSync(FREE_TIER_PATH, "utf8")); } catch {}
  const key = todayKey();
  const used = store[key] || 0;
  if (used >= limit) {
    return { ok: false, reason: "free_tier_daily_exceeded", used, limit, remaining: 0 };
  }
  store = { [key]: used + 1 }; // keep only today; older entries are auto-pruned
  fs.mkdirSync(path.dirname(FREE_TIER_PATH), { recursive: true });
  fs.writeFileSync(FREE_TIER_PATH, JSON.stringify(store));
  return { ok: true, used: used + 1, limit, remaining: limit - used - 1 };
}

const QUOTA_SERVER_URL = process.env.QUOTA_SERVER_URL || "http://localhost:3030";
const LEDGER_PATH = path.join(os.homedir(), ".smart-figma", "ledger.json");
const SNAPSHOT_PATH = path.join(os.homedir(), ".smart-figma", "quota_snapshot.json");

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")); }
  catch { return {}; }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")); }
  catch { return null; }
}

function saveSnapshot(snapshot) {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Deduct quota (server first, local fallback).
 * @param {object} opts
 * @param {string} opts.sub           user identifier (from the license)
 * @param {object} opts.quota         plan quota (from the license)
 * @param {string} opts.strategy      PURE_DIGITAL | SEMANTIC | VISUAL
 * @param {boolean} opts.byok         whether the user supplies their own key
 * @returns {Promise<{ok:boolean, reason?:string, remaining?:number, cost:number}>}
 */
export async function debit({ sub, quota, strategy, byok }) {
  const cost = CREDIT_COST[strategy] ?? CREDIT_COST.SEMANTIC;
  const idempotencyKey = crypto.randomUUID();

  // BYOK: the server never calls the LLM, so there is no credit to deduct here.
  // (Any client-side LLM call runs on the user's own key, not ours.)
  if (byok) return { ok: true, remaining: Infinity, cost, byok: true };

  // Visual fallback is only available to plans that include it (free tier costs us nothing).
  if (strategy === "VISUAL" && quota && quota.visualFallback === false) {
    return { ok: false, reason: "visual_not_in_plan", cost };
  }

  // ━━━ Server-side deduction ━━━
  const serverResult = await debitFromServer(sub, strategy, cost, idempotencyKey, quota);
  if (serverResult) return serverResult;

  // ━━━ Server unreachable -> optimistic local offline deduction ━━━
  return debitLocal(sub, quota, cost, idempotencyKey);
}

/** Issue a deduction against the server. */
async function debitFromServer(sub, strategy, cost, idempotencyKey, quota) {
  try {
    const res = await fetch(`${QUOTA_SERVER_URL}/quota/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sub,
        strategy,
        idempotency_key: idempotencyKey,
        monthlyLimit: (quota && quota.monthly) || 300,
      }),
      // Fail fast so we never block the compile flow.
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Success -> persist a local snapshot for future offline fallback.
    const snapshot = { sub, period: currentPeriod(), remaining: data.remaining, ts: Date.now() };
    saveSnapshot(snapshot);
    return data;
  } catch {
    return null; // network failure -> return null to trigger the local fallback
  }
}

/** Optimistic local offline deduction (fallback when the server is unreachable). */
function debitLocal(sub, quota, cost, idempotencyKey) {
  const monthly = (quota && quota.monthly) || 0;

  // Try to estimate from the snapshot (last successfully synced remaining balance).
  const snap = loadSnapshot();
  if (snap && snap.sub === sub && snap.period === currentPeriod() && snap.remaining !== undefined) {
    const remainingAfter = snap.remaining - cost;
    if (remainingAfter >= 0) {
      snap.remaining = remainingAfter;
      snap.ts = Date.now();
      saveSnapshot(snap);
      return { ok: true, remaining: remainingAfter, cost, serverDown: true };
    }
    return { ok: false, reason: "quota_exceeded_snapshot", cost, remaining: snap.remaining };
  }

  // Last resort: deduct once from the local ledger (do not block the user).
  const ledger = loadLedger();
  const period = currentPeriod();
  const key = `${sub}:${period}`;
  const used = ledger[key] || 0;

  if (used + cost > monthly && monthly > 0) {
    return { ok: false, reason: "quota_exceeded", remaining: Math.max(0, monthly - used), cost };
  }

  ledger[key] = used + cost;
  saveLedger(ledger);
  return { ok: true, remaining: Math.max(0, monthly - ledger[key]), cost, serverDown: true };
}

/** Query quota status from the server. */
export async function quotaStatus(sub) {
  try {
    const res = await fetch(`${QUOTA_SERVER_URL}/quota/status?sub=${encodeURIComponent(sub)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    const snap = loadSnapshot();
    if (snap && snap.sub === sub && snap.period === currentPeriod()) {
      return { ...snap, cached: true };
    }
    return null;
  }
}
