// issue-license.js — 发证 v2（发证服务器侧，持有私钥）
// 用法： node tools/issue-license.js --sub user@x.com --plan maker --days 30 --devices fp1,fp2 --quota-monthly 500
// 产出： 一个离线 license token，发给付费用户填进 MCP 配置的 SMART_FIGMA_LICENSE。
//
// v2 新增：--devices 多设备绑定、--quota-monthly 自定义配额、签发日志(keys/issue-log.jsonl)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { b64urlEncode } from "../src/license.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PLAN_QUOTA = {
  hacker: { monthly: 0, perDay: 10, visualFallback: false },
  maker: { monthly: 300, perDay: 1000, visualFallback: true },
  pro: { monthly: 1500, perDay: 5000, visualFallback: true },
  enterprise: { monthly: 1000000, perDay: 1000000, visualFallback: true },
};

const sub = arg("sub", "demo@local");
const plan = arg("plan", "maker");
const days = parseInt(arg("days", "30"), 10);
const devicesRaw = arg("devices", "");  // 逗号分隔的设备指纹
const quotaMonthly = parseInt(arg("quota-monthly", ""), 10) || null;

const privPath = path.join(__dirname, "..", "keys", "private.pem");
if (!fs.existsSync(privPath)) {
  console.error("❌ 找不到 keys/private.pem，请先运行 `npm run keygen`");
  process.exit(1);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, "utf8"));

const baseQuota = PLAN_QUOTA[plan] || PLAN_QUOTA.maker;
const quota = { ...baseQuota };
if (quotaMonthly) quota.monthly = quotaMonthly;

const devices = devicesRaw
  ? devicesRaw.split(",").map((d) => d.trim()).filter(Boolean)
  : [];

const jti = crypto.randomUUID();
const payload = {
  ver: 2,
  sub,
  plan,
  jti,
  quota,
  devices,
  iat: Date.now(),
  exp: Date.now() + days * 24 * 60 * 60 * 1000,
};

const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
const signature = crypto.sign(null, payloadBuf, privateKey);
const token = `${b64urlEncode(payloadBuf)}.${b64urlEncode(signature)}`;

console.log("✅ License 已签发：\n");
console.log(token);
console.log("\nPayload：", JSON.stringify(payload, null, 2));

// ━━━ 签发日志 ━━━
const logPath = path.join(__dirname, "..", "keys", "issue-log.jsonl");
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), action: "issue", jti, sub, plan, days, devices, quota: quota.monthly }) + "\n");
  console.log(`\n📝 签发日志已记录到 keys/issue-log.jsonl (jti: ${jti})`);
} catch (e) {
  console.error(`⚠️  签发日志写入失败: ${e.message}`);
}
