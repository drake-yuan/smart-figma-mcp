// issue-license.js — license issuance v2 (issuing-server side, holds the private key)
// Usage: node tools/issue-license.js --sub user@x.com --plan maker --days 30 --devices fp1,fp2 --quota-monthly 500
// Output: an offline license token to hand to a paying user; goes into the MCP env var SMART_FIGMA_LICENSE.
//
// v2 additions: --devices multi-device binding, --quota-monthly custom quota, issuance log (keys/issue-log.jsonl)
// v3 additions: export issueLicense() so batch-issue.js can reuse it

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

export function issueLicense({ sub, plan, days, devicesRaw, quotaMonthly }) {
  const privPath = path.join(__dirname, "..", "keys", "private.pem");
  if (!fs.existsSync(privPath)) {
    throw new Error("❌ keys/private.pem not found. Run `npm run keygen` first.");
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
    plan: plan || "maker",
    jti,
    quota,
    devices,
    iat: Date.now(),
    exp: Date.now() + (days || 30) * 24 * 60 * 60 * 1000,
  };

  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto.sign(null, payloadBuf, privateKey);
  const token = `${b64urlEncode(payloadBuf)}.${b64urlEncode(signature)}`;

  // Issuance log
  const logPath = path.join(__dirname, "..", "keys", "issue-log.jsonl");
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), action: "issue", jti, sub, plan, days, devices, quota: quota.monthly }) + "\n");
  } catch (e) {
    console.error(`⚠️  Failed to write issuance log: ${e.message}`);
  }

  return { token, payload, jti };
}

// CLI entry point
if (process.argv[1] && (process.argv[1].endsWith("issue-license.js") || process.argv[1].endsWith("issue"))) {
  const sub = arg("sub", "demo@local");
  const plan = arg("plan", "maker");
  const days = parseInt(arg("days", "30"), 10);
  const devicesRaw = arg("devices", "");
  const quotaMonthly = parseInt(arg("quota-monthly", ""), 10) || null;

  try {
    const result = issueLicense({ sub, plan, days, devicesRaw, quotaMonthly });
    console.log("✅ License issued:\n");
    console.log(result.token);
    console.log("\nPayload:", JSON.stringify(result.payload, null, 2));
    console.log(`\n📝 Issuance logged to keys/issue-log.jsonl (jti: ${result.jti})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
