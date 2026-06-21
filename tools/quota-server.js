// quota-server.js — 服务端权威账本 API
// 部署：可作为独立 Express/Cloudflare Worker 运行，接收客户端的配额扣减请求。
// 用法：node tools/quota-server.js  →  http://localhost:3030
//
// 铁律：所有扣减以服务端为准。客户端 quota.js 不可信任（可被篡改）。

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = parseInt(process.env.QUOTA_SERVER_PORT || "3030", 10);
const DB_PATH = path.join(os.homedir(), ".smart-figma", "quota-server.json");

const CREDIT_COST = { PURE_DIGITAL: 0.1, SEMANTIC: 1, VISUAL: 5 };

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return { quotas: {}, idem: {} }; }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// 清理过期幂等键（1h 后失效）
function cleanIdem(db) {
  const now = Date.now();
  for (const [k, v] of Object.entries(db.idem)) {
    if (now - v.ts > 3600000) delete db.idem[k];
  }
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(null); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // POST /quota/debit — 扣减配额
  if (req.method === "POST" && url.pathname === "/quota/debit") {
    const body = await readBody(req);
    if (!body || !body.sub || !body.strategy || !body.idempotency_key) {
      return json(res, 400, { error: "missing required fields" });
    }

    const db = loadDB();
    cleanIdem(db);

    // 幂等检查
    if (db.idem[body.idempotency_key]) {
      return json(res, 200, { ok: true, dedup: true });
    }

    const period = currentPeriod();
    const qKey = `${body.sub}:${period}`;
    const quota = db.quotas[qKey] || { limit: body.monthlyLimit || 300, used: 0 };
    const cost = CREDIT_COST[body.strategy] || CREDIT_COST.SEMANTIC;

    if (quota.used + cost > quota.limit) {
      return json(res, 200, { ok: false, reason: "exceeded", cost, remaining: Math.max(0, quota.limit - quota.used) });
    }

    quota.used += cost;
    db.quotas[qKey] = quota;
    db.idem[body.idempotency_key] = { ts: Date.now() };
    saveDB(db);

    return json(res, 200, { ok: true, cost, remaining: quota.limit - quota.used });
  }

  // GET /quota/status?sub=xxx&period=YYYY-MM  — 查询配额
  if (req.method === "GET" && url.pathname === "/quota/status") {
    const sub = url.searchParams.get("sub");
    const period = url.searchParams.get("period") || currentPeriod();
    if (!sub) return json(res, 400, { error: "missing sub" });

    const db = loadDB();
    const qKey = `${sub}:${period}`;
    const quota = db.quotas[qKey] || { limit: 300, used: 0 };

    return json(res, 200, {
      sub,
      period,
      limit: quota.limit,
      used: quota.used,
      remaining: quota.limit - quota.used,
    });
  }

  // POST /quota/reset — 重置指定用户配额（管理接口）
  if (req.method === "POST" && url.pathname === "/quota/reset") {
    const body = await readBody(req);
    if (!body || !body.sub) return json(res, 400, { error: "missing sub" });

    const db = loadDB();
    const period = body.period || currentPeriod();
    const qKey = `${body.sub}:${period}`;
    db.quotas[qKey] = { limit: body.limit || 300, used: 0 };
    saveDB(db);
    return json(res, 200, { ok: true });
  }

  // POST /quota/set-limit — 设置用户月度配额（管理接口）
  if (req.method === "POST" && url.pathname === "/quota/set-limit") {
    const body = await readBody(req);
    if (!body || !body.sub || typeof body.limit !== "number") return json(res, 400, { error: "missing sub/limit" });

    const db = loadDB();
    const period = body.period || currentPeriod();
    const qKey = `${body.sub}:${period}`;
    db.quotas[qKey] = { ...(db.quotas[qKey] || {}), limit: body.limit };
    saveDB(db);
    return json(res, 200, { ok: true });
  }

  // GET /health — 健康检查
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { status: "ok", uptime: process.uptime() });
  }

  json(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`[quota-server] listening on http://localhost:${PORT}`);
  console.log(`[quota-server] data: ${DB_PATH}`);
  console.log(`[quota-server] endpoints: POST /quota/debit, GET /quota/status, POST /quota/reset, POST /quota/set-limit`);
});
