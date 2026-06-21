// batch-issue.js — 从 CSV/JSON 批量签发 License
// 用法：
//   node tools/batch-issue.js users.csv          # CSV: sub,plan,days,quota_monthly
//   node tools/batch-issue.js users.json         # JSON: [{sub,plan,days,quotaMonthly}]
// 输出： CSV 格式 sub,token,jti

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

  throw new Error(`不支持的文件格式: ${ext} (需要 .csv 或 .json)`);
}

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("用法: node tools/batch-issue.js <users.csv|users.json>");
  process.exit(1);
}

console.error(`📋 读取 ${inputFile} ...`);
const users = loadInput(inputFile);
if (users.length === 0) {
  console.error("⚠️  没有找到用户数据");
  process.exit(0);
}

console.error(`👥 共 ${users.length} 个用户，开始签发...\n`);
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
    console.error(`❌ 签发失败 (${u.sub || `row_${count}`}): ${e.message}`);
  }
}

console.error(`\n✅ 完成：${count}/${users.length} 签发成功`);
