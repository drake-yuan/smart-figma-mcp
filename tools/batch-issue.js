// batch-issue.js — batch-issue licenses from a CSV/JSON file.
// Usage:
//   node tools/batch-issue.js users.csv          # CSV columns: sub,plan,days,quota_monthly
//   node tools/batch-issue.js users.json         # JSON: [{sub,plan,days,quotaMonthly}]
// Output: CSV rows of sub,token,jti

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issueLicense } from "./issue-license.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadInput(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    return JSON.parse(raw);
  }

  if (ext === ".csv") {
    const lines = raw.split("\n");
    if (lines.length < 2) return [];
    // header: sub,plan,days,quota_monthly,devices
    const header = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).filter(Boolean).map((line) => {
      const vals = line.split(",").map((v) => v.trim());
      const row = {};
      header.forEach((h, i) => { row[h] = vals[i] || ""; });
      return row;
    });
  }

  throw new Error(`Unsupported file format: ${ext} (expected .csv or .json)`);
}

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Usage: node tools/batch-issue.js <users.csv|users.json>");
  process.exit(1);
}

console.error(`📋 Reading ${inputFile} ...`);
const users = loadInput(inputFile);
if (users.length === 0) {
  console.error("⚠️  No user data found");
  process.exit(0);
}

console.error(`👥 ${users.length} users total, issuing...\n`);
console.log("sub,token,jti,plan,days_issued");

let count = 0;
for (const u of users) {
  try {
    const { sub, plan, days, quota_monthly, devices } = u;
    const result = issueLicense({
      sub: sub || `user_${count}@local`,
      plan: plan || "maker",
      days: parseInt(days, 10) || 30,
      devicesRaw: devices || "",
      quotaMonthly: parseInt(quota_monthly, 10) || null,
    });
    console.log(`${result.payload.sub},${result.token},${result.jti},${result.payload.plan},${Math.ceil((result.payload.exp - result.payload.iat) / 86400000)}`);
    count++;
  } catch (e) {
    console.error(`❌ Issuance failed (${u.sub || `row_${count}`}): ${e.message}`);
  }
}

console.error(`\n✅ Done: ${count}/${users.length} issued successfully`);
