// quota.js — Credits 配额（防薅羊毛第二道闸）
//
// 铁律：真实扣减以服务端为准，本地只缓存"剩余额度"。本地永远可被破解，不可信任。
// 本骨架用一个本地 JSON 文件模拟"服务端权威账本"，真实部署时把 serverDebit()
// 换成对你云端 /quota/debit 的一次网络请求即可。
//
// 成本对齐定价（与白皮书一致）：
//   纯数字编译  PURE_DIGITAL  = 0.1 credit （零 LLM，几乎不扣）
//   语义装配    SEMANTIC      = 1   credit
//   视觉降级    VISUAL        = 5   credits（真正烧钱，扣 50 倍）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CREDIT_COST = {
  PURE_DIGITAL: 0.1,
  SEMANTIC: 1,
  VISUAL: 5,
};

const LEDGER_PATH = path.join(os.homedir(), ".smart-figma", "ledger.json");

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 扣减配额。BYOK 模式下 token 走用户自己的 key，不消耗 credits → 直接放行。
 * @param {object} opts
 * @param {string} opts.sub           用户标识(来自 license)
 * @param {object} opts.quota         套餐配额(来自 license)
 * @param {string} opts.strategy      PURE_DIGITAL | SEMANTIC | VISUAL
 * @param {boolean} opts.byok         是否自带 key
 * @returns {{ok:boolean, reason?:string, remaining?:number, cost:number}}
 */
export function debit({ sub, quota, strategy, byok }) {
  const cost = CREDIT_COST[strategy] ?? CREDIT_COST.SEMANTIC;

  // BYOK：token 成本走用户账单，我方零变动成本 → 不扣 credits
  if (byok) return { ok: true, remaining: Infinity, cost, byok: true };

  // 视觉降级仅对开通该权益的套餐开放（免费档烧不到你一分钱）
  if (strategy === "VISUAL" && quota && quota.visualFallback === false) {
    return { ok: false, reason: "visual_not_in_plan", cost };
  }

  // ↓↓↓ 真实部署：把这一段换成 await fetch(YOUR_SERVER + "/quota/debit", ...)
  const ledger = loadLedger();
  const period = currentPeriod();
  const key = `${sub}:${period}`;
  const monthly = (quota && quota.monthly) || 0;
  const used = ledger[key] || 0;

  if (used + cost > monthly) {
    return { ok: false, reason: "quota_exceeded", remaining: Math.max(0, monthly - used), cost };
  }

  ledger[key] = used + cost;
  saveLedger(ledger);
  return { ok: true, remaining: monthly - ledger[key], cost };
}
