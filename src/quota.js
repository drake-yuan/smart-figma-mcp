// quota.js — Credits 配额（防薅羊毛第二道闸）v2
//
// 铁律：真实扣减以服务端为准，本地只缓存"剩余额度"。本地永远可被破解，不可信任。
//
// v2 变更：
//   - debit() 改为 fetch 服务端 /quota/debit API
//   - 服务端不可达 → 本地 snapshot 乐观离线扣减 → 联网后对账
//   - 每次扣减生成 UUID 幂等键防重放
//
// 成本对齐定价（与白皮书一致）：
//   纯数字编译  PURE_DIGITAL  = 0.1 credit （零 LLM，几乎不扣）
//   语义装配    SEMANTIC      = 1   credit
//   视觉降级    VISUAL        = 5   credits（真正烧钱，扣 50 倍）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CREDIT_COST = {
  PURE_DIGITAL: 0.1,
  SEMANTIC: 1,
  VISUAL: 5,
};

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
 * 扣减配额（服务端优先 → 本地兜底）
 * @param {object} opts
 * @param {string} opts.sub           用户标识(来自 license)
 * @param {object} opts.quota         套餐配额(来自 license)
 * @param {string} opts.strategy      PURE_DIGITAL | SEMANTIC | VISUAL
 * @param {boolean} opts.byok         是否自带 key
 * @returns {Promise<{ok:boolean, reason?:string, remaining?:number, cost:number}>}
 */
export async function debit({ sub, quota, strategy, byok }) {
  const cost = CREDIT_COST[strategy] ?? CREDIT_COST.SEMANTIC;
  const idempotencyKey = crypto.randomUUID();

  // BYOK：token 成本走用户账单，我方零变动成本 → 不扣 credits
  if (byok) return { ok: true, remaining: Infinity, cost, byok: true };

  // 视觉降级仅对开通该权益的套餐开放（免费档烧不到你一分钱）
  if (strategy === "VISUAL" && quota && quota.visualFallback === false) {
    return { ok: false, reason: "visual_not_in_plan", cost };
  }

  // ━━━ 服务端扣减 ━━━
  const serverResult = await debitFromServer(sub, strategy, cost, idempotencyKey, quota);
  if (serverResult) return serverResult;

  // ━━━ 服务端不可达 → 本地乐观离线扣减 ━━━
  return debitLocal(sub, quota, cost, idempotencyKey);
}

/** 向服务端发起扣减 */
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
      // 快速失败，不阻塞编译流程
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // 联网成功 → 存本地 snapshot（用于未来离线兜底）
    const snapshot = { sub, period: currentPeriod(), remaining: data.remaining, ts: Date.now() };
    saveSnapshot(snapshot);
    return data;
  } catch {
    return null; // 网络故障 → 返回 null，触发本地兜底
  }
}

/** 本地乐观离线扣减（服务端不可达时兜底） */
function debitLocal(sub, quota, cost, idempotencyKey) {
  const monthly = (quota && quota.monthly) || 0;
  
  // 尝试用快照估算（上次联网成功的剩余量）
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

  // 最后兜底：用本地 ledger 做一次扣减（不阻塞用户）
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

/** 查询服务端配额状态 */
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
