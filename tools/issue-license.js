// issue-license.js — 发证（发证服务器侧，持有私钥）
// 用法： node tools/issue-license.js --sub user@x.com --plan maker --days 30 --device <fingerprint>
// 产出： 一个离线 license token，发给付费用户填进 MCP 配置的 SMART_FIGMA_LICENSE。

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
const device = arg("device", ""); // 空 = 不绑定设备(仅演示)

const privPath = path.join(__dirname, "..", "keys", "private.pem");
if (!fs.existsSync(privPath)) {
  console.error("❌ 找不到 keys/private.pem，请先运行 `npm run keygen`");
  process.exit(1);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, "utf8"));

const payload = {
  sub,
  plan,
  quota: PLAN_QUOTA[plan] || PLAN_QUOTA.maker,
  devices: device ? [device] : [],
  iat: Date.now(),
  exp: Date.now() + days * 24 * 60 * 60 * 1000,
};

const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
const signature = crypto.sign(null, payloadBuf, privateKey);
const token = `${b64urlEncode(payloadBuf)}.${b64urlEncode(signature)}`;

console.log("✅ License 已签发：\n");
console.log(token);
console.log("\nPayload：", JSON.stringify(payload, null, 2));
